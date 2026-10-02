import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants, type Tenant } from '../../db/tenants.ts'
import { dayRangeUtc, formatTime, toIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { contractTypeLabels } from '../contrats/labels.ts'
import { contractLines, contracts } from '../contrats/schema.ts'
import { mailItems, mailRequests } from '../courrier/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { frozenQuoteDisplay } from './devis.ts'
import { pgMessage } from './factures-erreurs.ts'
import { invoicePaymentSetup } from './mandats.ts'
import {
  computeRun,
  contractKey,
  issuedInvoiceWarning,
  previewAmounts,
  type BillingContract,
  type ClientRun,
  type InvoiceLineDraft,
  type RunSettings,
  type RunSources,
  type RunWarning,
} from './lot.ts'
import { monthRange, runWindows, type DateRange, type RunWindows } from './periodes.ts'
import {
  invoiceLines,
  invoiceRuns,
  invoices,
  subscribedServices,
  type InvoiceRun,
  type InvoiceRunResult,
  type InvoiceStatus,
} from './schema-factures.ts'
import { serviceCodes, services } from './schema.ts'

/**
 * Lot de facturation périodique, côté base (R13, ADR 026, ADR 029) : lire ce
 * qui est dû et ce qui est déjà facturé, en tirer les lignes (`lot.ts`), puis
 * écrire une facture brouillon par client — et journaliser le lot.
 *
 * Le lot n'émet rien : l'équipe relit les brouillons, puis émet.
 */

/** Bilan d'un lot, tel que le schéma le déclare (`invoice_runs.result`). */
export type InvoiceRunReport = InvoiceRunResult

/** Facture de lot déjà présente pour un client et la période. */
type ExistingRunInvoice = {
  id: string
  status: InvoiceStatus
  number: string | null
  maxPosition: number
}

type LoadedRun = {
  settings: RunSettings
  tenant: Tenant
  sources: RunSources
  clientNames: Map<string, string>
  existing: Map<string, ExistingRunInvoice>
  /** Clients en activité, pour compter ceux qui n'ont rien à facturer. */
  activeClientIds: string[]
}

const asRange = (start: string, end: string): DateRange => ({ start, end })

function pushRange(map: Map<string, DateRange[]>, key: string, range: DateRange) {
  const ranges = map.get(key)
  if (ranges) ranges.push(range)
  else map.set(key, [range])
}

/**
 * Une souscription se facture seule, ou avec un contrat engagé (actif ou
 * résilié, non archivé) : celles qu'un brouillon de contrat porte déjà (actes
 * inclus d'une offre, ADR 028) attendent son activation, et celles d'un
 * contrat archivé ne se facturent plus.
 */
const subscriptionContractIsLive = () =>
  or(
    isNull(subscribedServices.contractId),
    sql`exists (
      select 1 from contracts as k
       where k.tenant_id = subscribed_services.tenant_id
         and k.id = subscribed_services.contract_id
         and k.deleted_at is null
         and k.status in ('active', 'terminated'))`,
  )

/** Bornes larges des périodes civiles qu'un lot peut toucher : l'année entière. */
function yearSpan(window: DateRange): DateRange {
  return { start: `${window.start.slice(0, 4)}-01-01`, end: `${window.end.slice(0, 4)}-12-31` }
}

async function loadRun(tx: Transaction, tenantId: string, month: string): Promise<LoadedRun> {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!tenant) throw new Error('Centre introuvable.')

  const windows = runWindows(month, tenant.recurringBillingTiming)
  const settings: RunSettings = {
    windows,
    timing: tenant.recurringBillingTiming,
    prorataRule: tenant.prorataRule,
    currency: tenant.currency,
  }
  const span = yearSpan(windows.recurring)

  /* Contrats engagés qui peuvent avoir une échéance dans la fenêtre. */
  const contractRows = await tx
    .select({
      id: contracts.id,
      clientId: contracts.clientId,
      reference: contracts.reference,
      contractType: contracts.contractType,
      billingPeriod: contracts.billingPeriod,
      currency: contracts.currency,
      vatRateBp: contracts.vatRateBp,
    })
    .from(contracts)
    .where(
      and(
        isNull(contracts.deletedAt),
        inArray(contracts.status, ['active', 'terminated']),
        lte(contracts.startsOn, span.end),
        sql`coalesce(least(${contracts.endsOn}, ${contracts.terminatedOn}), 'infinity'::date) >= ${span.start}::date`,
      ),
    )
  const contractIds = contractRows.map((row) => row.id)

  const versionRows = contractIds.length
    ? await tx.execute<{
        contract_id: string
        amendment_id: string | null
        amendment_number: number | null
        starts_on: string
        ends_on: string | null
        amount_cents: number
      }>(sql`
        select contracts.id as contract_id, v.amendment_id, v.amendment_number,
               v.starts_on::text as starts_on, v.ends_on::text as ends_on, v.amount_cents
          from contracts
          cross join lateral contract_price_versions(contracts.id) as v
         where ${inArray(contracts.id, contractIds)}`)
    : []
  const segmentRows = contractIds.length
    ? await tx.execute<{
        contract_id: string
        resource_id: string | null
        starts_on: string
        ends_on: string | null
      }>(sql`
        select contracts.id as contract_id, s.resource_id,
               s.starts_on::text as starts_on, s.ends_on::text as ends_on
          from contracts
          cross join lateral contract_segments(contracts) as s
         where ${inArray(contracts.id, contractIds)}`)
    : []
  const lineRows = contractIds.length
    ? await tx
        .select()
        .from(contractLines)
        .where(and(inArray(contractLines.contractId, contractIds), isNull(contractLines.deletedAt)))
    : []
  const contractBilledRows = contractIds.length
    ? await tx
        .select({
          contractId: invoiceLines.contractId,
          contractLineId: invoiceLines.contractLineId,
          periodStart: invoiceLines.periodStart,
          periodEnd: invoiceLines.periodEnd,
        })
        .from(invoiceLines)
        .where(
          and(
            inArray(invoiceLines.kind, ['rent', 'package']),
            inArray(invoiceLines.contractId, contractIds),
            isNull(invoiceLines.subscribedServiceId),
            isNotNull(invoiceLines.periodStart),
            isNull(invoiceLines.deletedAt),
            isNull(invoiceLines.releasedAt),
          ),
        )
    : []

  const contractBilled = new Map<string, DateRange[]>()
  for (const row of contractBilledRows) {
    if (!row.contractId || !row.periodStart || !row.periodEnd) continue
    pushRange(contractBilled, contractKey(row.contractId, row.contractLineId), asRange(row.periodStart, row.periodEnd))
  }

  const billingContracts: BillingContract[] = contractRows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    reference: row.reference,
    label: contractTypeLabels[row.contractType],
    billingPeriod: row.billingPeriod,
    currency: row.currency,
    vatRateBp: row.vatRateBp,
    versions: versionRows
      .filter((version) => version.contract_id === row.id)
      .map((version) => ({
        amendmentId: version.amendment_id,
        amendmentNumber: version.amendment_number,
        startsOn: version.starts_on,
        endsOn: version.ends_on,
        amountCents: Number(version.amount_cents),
      })),
    lines: lineRows
      .filter((line) => line.contractId === row.id)
      .map((line) => ({
        id: line.id,
        amendmentId: line.amendmentId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        discountBp: line.discountBp,
        discountAmountCents: line.discountAmountCents,
        vatRateBp: line.vatRateBp,
        isRecurring: line.isRecurring,
        serviceId: line.serviceId,
        resourceId: line.resourceId,
        position: line.position,
      })),
    segments: segmentRows
      .filter((segment) => segment.contract_id === row.id)
      .map((segment) => ({
        startsOn: segment.starts_on,
        endsOn: segment.ends_on,
        resourceId: segment.resource_id,
      })),
  }))

  /* Forfaits souscrits qui touchent la fenêtre du récurrent. */
  const subscriptionRows = await tx
    .select({
      subscription: subscribedServices,
      serviceName: services.name,
    })
    .from(subscribedServices)
    .innerJoin(services, eq(services.id, subscribedServices.serviceId))
    .where(
      and(
        isNull(subscribedServices.deletedAt),
        subscriptionContractIsLive(),
        eq(services.nature, 'package'),
        lte(subscribedServices.startsOn, windows.recurring.end),
        or(isNull(subscribedServices.endsOn), gte(subscribedServices.endsOn, windows.recurring.start)),
      ),
    )
  const subscriptionIds = subscriptionRows.map((row) => row.subscription.id)
  const subscriptionBilledRows = subscriptionIds.length
    ? await tx
        .select({
          subscribedServiceId: invoiceLines.subscribedServiceId,
          periodStart: invoiceLines.periodStart,
          periodEnd: invoiceLines.periodEnd,
        })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.kind, 'package'),
            inArray(invoiceLines.subscribedServiceId, subscriptionIds),
            isNotNull(invoiceLines.periodStart),
            isNull(invoiceLines.deletedAt),
            isNull(invoiceLines.releasedAt),
          ),
        )
    : []
  const subscriptionBilled = new Map<string, DateRange[]>()
  for (const row of subscriptionBilledRows) {
    if (!row.subscribedServiceId || !row.periodStart || !row.periodEnd) continue
    pushRange(subscriptionBilled, row.subscribedServiceId, asRange(row.periodStart, row.periodEnd))
  }

  /* Consommations du mois précédent, jours du centre. */
  const consumption = {
    startsAt: dayRangeUtc(windows.consumption.start, tenant.timezone).startsAt,
    endsAt: dayRangeUtc(windows.consumption.end, tenant.timezone).endsAt,
  }
  const bookingRows = await tx
    .select({
      booking: bookings,
      resourceName: resources.name,
      held: sql<boolean>`exists (
        select 1 from invoice_lines as l
         where l.tenant_id = bookings.tenant_id and l.booking_id = bookings.id
           and l.deleted_at is null and l.released_at is null)`,
    })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(
      and(
        eq(bookings.kind, 'booking'),
        eq(bookings.status, 'confirmed'),
        isNotNull(bookings.clientId),
        gte(bookings.startsAt, consumption.startsAt),
        lt(bookings.startsAt, consumption.endsAt),
      ),
    )

  const mailRows = await tx
    .select({
      id: mailItems.id,
      clientId: mailItems.clientId,
      openedAt: mailItems.openedAt,
      held: sql<boolean>`exists (
        select 1 from invoice_lines as l
         where l.tenant_id = mail_items.tenant_id and l.mail_item_id = mail_items.id
           and l.deleted_at is null and l.released_at is null)`,
    })
    .from(mailItems)
    .where(
      and(
        isNull(mailItems.deletedAt),
        gte(mailItems.openedAt, consumption.startsAt),
        lt(mailItems.openedAt, consumption.endsAt),
      ),
    )

  /** Service d'un acte, retrouvé par son code ; nul s'il n'est pas (ou plus) au catalogue. */
  const actServiceRow = async (code: string) => {
    const [service] = await tx
      .select()
      .from(services)
      .where(and(eq(services.code, code), isNull(services.deletedAt)))
      .limit(1)
    return service ?? null
  }
  /** Le service, et les souscriptions qui le couvrent entre `from` et la fin de la période. */
  const actService = async (service: typeof services.$inferSelect | null, from: string) => {
    const subscriptions = service
      ? await tx
          .select()
          .from(subscribedServices)
          .where(
            and(
              eq(subscribedServices.serviceId, service.id),
              isNull(subscribedServices.deletedAt),
              subscriptionContractIsLive(),
              lte(subscribedServices.startsOn, windows.consumption.end),
              or(isNull(subscribedServices.endsOn), gte(subscribedServices.endsOn, from)),
            ),
          )
      : []
    return {
      service: service
        ? {
            id: service.id,
            name: service.name,
            unitPriceCents: service.unitPriceCents,
            vatRateBp: service.vatRateBp,
            currency: service.currency,
          }
        : null,
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        clientId: subscription.clientId,
        includedQuantity: subscription.includedQuantity,
        unitPriceCents: subscription.unitPriceCents,
        discountBp: subscription.discountBp,
        discountAmountCents: subscription.discountAmountCents,
        vatRateBp: subscription.vatRateBp,
        currency: subscription.currency,
        startsOn: subscription.startsOn,
        endsOn: subscription.endsOn,
      })),
    }
  }
  const opening = await actService(await actServiceRow(serviceCodes.mailOpening), windows.consumption.start)
  const requestServiceRows = {
    scan: await actServiceRow(serviceCodes.mailScan),
    forward: await actServiceRow(serviceCodes.mailForwarding),
  }

  /*
   * Demandes de courrier faites dans la période (ADR 037) : numérisations et
   * réexpéditions, chacune tenue au plus une fois par ligne de son acte, et
   * par ligne de ses frais d'affranchissement. Un pli retiré (enregistré par
   * erreur) sort de la facturation avec elles.
   *
   * Rattrapage : une demande faite avant la période et jamais tenue par une
   * ligne d'acte — une réexpédition qui attendait ses frais, la demande d'un
   * client dont la facture était déjà émise — est reprise par ce lot. Seules
   * celles faites quand leur service était au catalogue : le rattrapage
   * reprend ce qu'un lot a laissé de côté, pas ce que le centre n'a jamais
   * facturé. Les mois concernés sont chargés en entier, facturé ou non, pour
   * que le rang des inclus soit celui du mois de la demande (ADR 035).
   */
  const heldBy = (kind: 'act' | 'other') => sql<boolean>`exists (
    select 1 from invoice_lines as l
     where l.tenant_id = mail_requests.tenant_id and l.mail_request_id = mail_requests.id
       and l.kind = ${kind} and l.deleted_at is null and l.released_at is null)`
  const sinceService = (['scan', 'forward'] as const).flatMap((kind) => {
    const service = requestServiceRows[kind]
    return service ? [and(eq(mailRequests.kind, kind), gte(mailRequests.completedAt, service.createdAt))] : []
  })
  const [pending] = sinceService.length
    ? await tx
        .select({
          month: sql<string | null>`to_char(min(${mailRequests.completedAt} at time zone ${tenant.timezone}), 'YYYY-MM')`,
        })
        .from(mailRequests)
        .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
        .where(
          and(
            eq(mailRequests.status, 'done'),
            isNull(mailItems.deletedAt),
            lt(mailRequests.completedAt, consumption.startsAt),
            or(...sinceService),
            sql`not ${heldBy('act')}`,
          ),
        )
    : []
  const requestsFrom = pending?.month ? `${pending.month}-01` : windows.consumption.start
  const requestsStartAt = dayRangeUtc(requestsFrom, tenant.timezone).startsAt
  const scanning = await actService(requestServiceRows.scan, requestsFrom)
  const forwarding = await actService(requestServiceRows.forward, requestsFrom)

  const requestRows = await tx
    .select({
      id: mailRequests.id,
      clientId: mailRequests.clientId,
      kind: mailRequests.kind,
      completedAt: mailRequests.completedAt,
      postageCents: mailRequests.postageCents,
      postageCurrency: mailRequests.postageCurrency,
      held: heldBy('act'),
      postageHeld: heldBy('other'),
    })
    .from(mailRequests)
    .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
    .where(
      and(
        eq(mailRequests.status, 'done'),
        inArray(mailRequests.kind, ['scan', 'forward']),
        isNull(mailItems.deletedAt),
        gte(mailRequests.completedAt, requestsStartAt),
        lt(mailRequests.completedAt, consumption.endsAt),
      ),
    )
  /** Faite dans la période, ou reprise par le rattrapage. */
  const billableRequest = (row: (typeof requestRows)[number]) => {
    const completedAt = row.completedAt as Date
    if (completedAt >= consumption.startsAt) return true
    const service = requestServiceRows[row.kind as 'scan' | 'forward']
    return service !== null && completedAt >= service.createdAt
  }

  const sources: RunSources = {
    contracts: billingContracts,
    contractBilled,
    subscriptions: subscriptionRows.map(({ subscription, serviceName }) => ({
      id: subscription.id,
      clientId: subscription.clientId,
      contractId: subscription.contractId,
      serviceId: subscription.serviceId,
      serviceName,
      quantity: subscription.quantity,
      unit: subscription.unit,
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
      discountAmountCents: subscription.discountAmountCents,
      vatRateBp: subscription.vatRateBp,
      currency: subscription.currency,
      startsOn: subscription.startsOn,
      endsOn: subscription.endsOn,
    })),
    subscriptionBilled,
    bookings: bookingRows.map(({ booking, resourceName, held }) => {
      // Le devis figé (R11, ADR 023), lu par la même règle que la fiche de la
      // réservation : sans devis complet, la réservation est signalée.
      const frozen = frozenQuoteDisplay(booking)
      return {
        id: booking.id,
        clientId: booking.clientId as string,
        resourceId: booking.resourceId,
        resourceName,
        day: toIsoDate(booking.startsAt, tenant.timezone),
        startTime: formatTime(booking.startsAt, tenant.timezone),
        endTime: formatTime(booking.endsAt, tenant.timezone),
        quote: frozen
          ? {
              unit: frozen.unit,
              quantity: frozen.quantity,
              unitPriceCents: frozen.unitPriceCents,
              discountBp: frozen.discountBp,
              discountAmountCents: frozen.discountAmountCents,
              vatRateBp: frozen.vatRateBp,
              currency: frozen.currency,
            }
          : null,
        held: Boolean(held),
      }
    }),
    mailItems: mailRows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      openedAt: row.openedAt as Date,
      day: toIsoDate(row.openedAt as Date, tenant.timezone),
      held: Boolean(row.held),
    })),
    actService: opening.service,
    actSubscriptions: opening.subscriptions,
    mailRequests: requestRows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      kind: row.kind as 'scan' | 'forward',
      completedAt: row.completedAt as Date,
      day: toIsoDate(row.completedAt as Date, tenant.timezone),
      held: Boolean(row.held),
      postageRecorded: row.kind === 'forward' ? row.postageCents !== null : undefined,
      ...(billableRequest(row) ? {} : { billable: false }),
    })),
    requestServices: { scan: scanning.service, forward: forwarding.service },
    requestSubscriptions: { scan: scanning.subscriptions, forward: forwarding.subscriptions },
    // Des frais nuls ne font pas de ligne ; des frais déjà tenus, pas deux.
    // Ceux d'un mois antérieur suivent leur acte rattrapé, jamais seuls.
    postages: requestRows
      .filter(
        (row) =>
          row.kind === 'forward' &&
          (row.postageCents ?? 0) > 0 &&
          !row.postageHeld &&
          ((row.completedAt as Date) >= consumption.startsAt || (billableRequest(row) && !row.held)),
      )
      .map((row) => ({
        requestId: row.id,
        clientId: row.clientId,
        day: toIsoDate(row.completedAt as Date, tenant.timezone),
        postageCents: row.postageCents as number,
        currency: row.postageCurrency as string,
      })),
  }

  const clientRows = await tx
    .select({ id: clients.id, name: clients.name, status: clients.status, deletedAt: clients.deletedAt })
    .from(clients)
  const existingRows = await tx
    .select({
      id: invoices.id,
      clientId: invoices.clientId,
      status: invoices.status,
      number: invoices.number,
      maxPosition: sql<number>`(
        select coalesce(max(l.position), -1) from invoice_lines as l
         where l.tenant_id = invoices.tenant_id and l.invoice_id = invoices.id
           and l.deleted_at is null)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.kind, 'invoice'),
        isNotNull(invoices.invoiceRunId),
        isNull(invoices.deletedAt),
        ne(invoices.status, 'cancelled'),
        eq(invoices.periodStart, windows.invoice.start),
        eq(invoices.periodEnd, windows.invoice.end),
      ),
    )

  return {
    settings,
    tenant,
    sources,
    clientNames: new Map(clientRows.map((row) => [row.id, row.name])),
    activeClientIds: clientRows
      .filter((row) => row.status === 'active' && row.deletedAt === null)
      .map((row) => row.id),
    existing: new Map(
      existingRows.map((row) => [
        row.clientId,
        { id: row.id, status: row.status, number: row.number, maxPosition: Number(row.maxPosition) },
      ]),
    ),
  }
}

/* -------------------------------------------------------------------------- */
/* Aperçu                                                                     */
/* -------------------------------------------------------------------------- */

export type ClientRunPreview = {
  clientId: string
  clientName: string
  lines: InvoiceLineDraft[]
  warnings: RunWarning[]
  totals: { exclTaxCents: number; taxCents: number; inclTaxCents: number }
  /** Facture de lot déjà présente pour la période : complétée si brouillon, intouchable si émise. */
  existing: { id: string; status: InvoiceStatus; number: string | null } | null
}

export type RunPreview = {
  month: string
  windows: RunWindows
  timing: Tenant['recurringBillingTiming']
  currency: string
  clients: ClientRunPreview[]
  /** Clients en activité qui n'ont rien à facturer. */
  idleClientCount: number
}

const byName = (a: { clientName: string }, b: { clientName: string }) =>
  a.clientName.localeCompare(b.clientName, 'fr')

function describe(loaded: LoadedRun, run: ClientRun): ClientRunPreview {
  const amounts = previewAmounts(run.lines)
  const existing = loaded.existing.get(run.clientId)
  return {
    clientId: run.clientId,
    clientName: loaded.clientNames.get(run.clientId) ?? 'Client inconnu',
    lines: run.lines,
    warnings: run.warnings,
    totals: {
      exclTaxCents: amounts.totalExclTaxCents,
      taxCents: amounts.totalTaxCents,
      inclTaxCents: amounts.totalInclTaxCents,
    },
    existing: existing ? { id: existing.id, status: existing.status, number: existing.number } : null,
  }
}

/**
 * Ce que le lot de ce mois écrirait, sans rien écrire : par client, les lignes
 * à facturer, leurs montants annoncés, et ce qui reste à reprendre à la main.
 */
export async function previewInvoiceRun(month: string): Promise<RunPreview> {
  return withTenant(currentTenantId(), async (tx) => {
    const loaded = await loadRun(tx, currentTenantId(), month)
    const runs = computeRun(loaded.sources, loaded.settings)
    const billed = new Set(runs.filter((run) => run.lines.length > 0).map((run) => run.clientId))
    return {
      month,
      windows: loaded.settings.windows,
      timing: loaded.settings.timing,
      currency: loaded.settings.currency,
      clients: runs.map((run) => describe(loaded, run)).sort(byName),
      idleClientCount: loaded.activeClientIds.filter((id) => !billed.has(id)).length,
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                  */
/* -------------------------------------------------------------------------- */

/** Un autre lot est en cours dans le centre (un seul à la fois, ADR 026). */
export class InvoiceRunInProgressError extends Error {
  constructor() {
    super('Un lot de facturation est déjà en cours : attendez qu’il se termine, puis relancez.')
    this.name = 'InvoiceRunInProgressError'
  }
}

/** Un lot resté « en cours » plus longtemps que ceci a été interrompu. */
const STALE_RUN_MINUTES = 30

function lineValues(invoiceId: string, line: InvoiceLineDraft, position: number) {
  return {
    invoiceId,
    position,
    kind: line.kind,
    description: line.description,
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
    quantity: line.quantity,
    unit: line.unit,
    unitPriceCents: line.unitPriceCents,
    discountBp: line.discountBp,
    discountAmountCents: line.discountAmountCents,
    prorataNumerator: line.prorataNumerator,
    prorataDenominator: line.prorataDenominator,
    vatRateBp: line.vatRateBp,
    vatCategory: line.vatCategory,
    contractId: line.contractId,
    contractLineId: line.contractLineId,
    bookingId: line.bookingId,
    subscribedServiceId: line.subscribedServiceId,
    mailItemId: line.mailItemId,
    mailRequestId: line.mailRequestId,
    serviceId: line.serviceId,
    resourceId: line.resourceId,
  }
}

/**
 * Lance le lot du mois : une facture brouillon par client qui a quelque chose
 * à facturer, réunissant loyers, forfaits, réservations et actes (R15).
 *
 * - **Journalisé** : le lot est inscrit (`running`) avant tout, puis terminé
 *   (`completed`, avec son bilan) ou noté en échec (`failed`, avec la cause).
 *   Un lot resté en cours plus de trente minutes est réputé interrompu.
 * - **Un seul à la fois** : un second lancement est refusé
 *   (`InvoiceRunInProgressError`).
 * - **Rejouable sans doublon** : un client qui a déjà sa facture de lot pour
 *   la période la voit complétée si c'est encore un brouillon, et laissée
 *   telle quelle si elle est émise ; seul ce qui n'est pas encore facturé est
 *   ajouté. La base refuse de toute façon une source facturée deux fois.
 * - **Un client à la fois** : un refus de la base pour un client (source prise
 *   entre-temps, ligne incohérente) annule ce client seul, le lot continue et
 *   le note dans son bilan.
 *
 * `staffMemberId` nul : le lot est lancé par la tâche planifiée du serveur
 * (`/api/maintenance/facturation`, ADR 033).
 */
export async function runInvoicing(
  month: string,
  staffMemberId: string | null,
): Promise<{ runId: string; report: InvoiceRunReport }> {
  const tenantId = currentTenantId()
  const period = monthRange(month)

  let runId: string
  try {
    runId = await withTenant(tenantId, async (tx) => {
      await tx
        .update(invoiceRuns)
        .set({
          status: 'failed',
          finishedAt: sql`now()`,
          result: sql`${invoiceRuns.result} || jsonb_build_object('error', 'Lot interrompu avant sa fin.')`,
        })
        .where(
          and(
            eq(invoiceRuns.status, 'running'),
            lt(invoiceRuns.startedAt, sql`now() - make_interval(mins => ${STALE_RUN_MINUTES})`),
          ),
        )
      const [run] = await tx
        .insert(invoiceRuns)
        .values({
          periodStart: period.start,
          periodEnd: period.end,
          createdBy: staffMemberId,
        })
        .returning({ id: invoiceRuns.id })
      return run.id
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new InvoiceRunInProgressError()
    throw error
  }

  try {
    const report = await withTenant(tenantId, async (tx) => {
      const loaded = await loadRun(tx, tenantId, month)
      const runs = computeRun(loaded.sources, loaded.settings)
      const report: InvoiceRunReport = {
        invoicesCreated: 0,
        invoicesUpdated: 0,
        linesCreated: 0,
        clientsSkipped: 0,
        warnings: [],
      }
      const warnings = report.warnings as RunWarning[]
      const billed = new Set<string>()

      for (const run of runs.sort((a, b) => (a.clientId < b.clientId ? -1 : 1))) {
        warnings.push(...run.warnings)
        if (run.lines.length === 0) continue
        const existing = loaded.existing.get(run.clientId)
        if (existing && existing.status !== 'draft') {
          warnings.push({ clientId: run.clientId, message: issuedInvoiceWarning(existing.number, run.lines) })
          continue
        }
        try {
          await tx.transaction(async (savepoint) => {
            let invoiceId = existing?.id
            if (!invoiceId) {
              // Prélèvement sur le mandat actif et non caduc du client, sinon le
              // mode du centre (ADR 027, `invoicePaymentSetup`).
              const payment = await invoicePaymentSetup(
                savepoint,
                run.clientId,
                todayIsoDate(loaded.tenant.timezone),
              )
              const [created] = await savepoint
                .insert(invoices)
                .values({
                  clientId: run.clientId,
                  invoiceRunId: runId,
                  periodStart: loaded.settings.windows.invoice.start,
                  periodEnd: loaded.settings.windows.invoice.end,
                  currency: loaded.settings.currency,
                  expectedPaymentMethod: payment.expectedPaymentMethod,
                  sepaMandateId: payment.sepaMandateId,
                })
                .returning({ id: invoices.id })
              invoiceId = created.id
            }
            const first = existing ? existing.maxPosition + 1 : 0
            // Une seule instruction : la base recalcule TVA et totaux une fois.
            await savepoint
              .insert(invoiceLines)
              .values(run.lines.map((line, index) => lineValues(invoiceId as string, line, first + index)))
          })
          billed.add(run.clientId)
          report.linesCreated = (report.linesCreated ?? 0) + run.lines.length
          if (existing) report.invoicesUpdated = (report.invoicesUpdated ?? 0) + 1
          else report.invoicesCreated = (report.invoicesCreated ?? 0) + 1
        } catch (error) {
          warnings.push({
            clientId: run.clientId,
            message: `Facture non préparée, à reprendre : ${pgMessage(error)}`,
          })
        }
      }

      report.clientsSkipped = loaded.activeClientIds.filter((id) => !billed.has(id)).length
      await tx
        .update(invoiceRuns)
        .set({ status: 'completed', finishedAt: sql`now()`, result: report })
        .where(eq(invoiceRuns.id, runId))
      return report
    })
    return { runId, report }
  } catch (error) {
    await withTenant(tenantId, (tx) =>
      tx
        .update(invoiceRuns)
        .set({ status: 'failed', finishedAt: sql`now()`, result: { error: pgMessage(error) } })
        .where(eq(invoiceRuns.id, runId)),
    )
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Journal                                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceRunEntry = InvoiceRun & {
  report: InvoiceRunReport
  /** Membre de l'équipe qui l'a lancé, ou « Tâche planifiée » (ADR 033). */
  createdByName: string
}

/** Auteur d'un lot : le membre de l'équipe, ou la tâche planifiée du serveur. */
const runAuthor = sql<string>`coalesce(${staffMembers.fullName}, ${staffMembers.email}, 'Tâche planifiée')`

/** Derniers lots du centre, le plus récent d'abord. */
export async function listInvoiceRuns(limit = 12): Promise<InvoiceRunEntry[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ run: invoiceRuns, name: runAuthor })
      .from(invoiceRuns)
      .leftJoin(staffMembers, eq(staffMembers.id, invoiceRuns.createdBy))
      .orderBy(desc(invoiceRuns.startedAt), asc(invoiceRuns.id))
      .limit(limit),
  )
  return rows.map(({ run, name }) => ({ ...run, report: run.result as InvoiceRunReport, createdByName: name }))
}

export async function findInvoiceRun(id: string): Promise<InvoiceRunEntry | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ run: invoiceRuns, name: runAuthor })
      .from(invoiceRuns)
      .leftJoin(staffMembers, eq(staffMembers.id, invoiceRuns.createdBy))
      .where(eq(invoiceRuns.id, id))
      .limit(1),
  )
  return row ? { ...row.run, report: row.run.result as InvoiceRunReport, createdByName: row.name } : undefined
}

/** Noms des clients cités par un bilan de lot. */
export async function clientNamesFor(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, unique)),
  )
  return new Map(rows.map((row) => [row.id, row.name]))
}
