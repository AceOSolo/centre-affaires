import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { addDaysToIsoDate, addMonthsToIsoMonth, monthRangeUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { listContractFeesForAccounts } from '../contrats/compte-queries.ts'
import { mailItems, mailRequests, mailScans } from '../courrier/schema.ts'
import { subscribedServices } from '../facturation/schema-factures.ts'
import { serviceCodes, services } from '../facturation/schema.ts'
import type { ActCatalogueService, ActSubscription } from '../facturation/souscriptions-regles.ts'
import { bookings } from '../reservations/schema.ts'
import {
  bookingSources,
  coveredByProposal,
  openingSources,
  pageSources,
  requestSources,
} from './consommations-queries.ts'
import type { ConsumptionSource } from './consommations.ts'
import {
  buildExpenseMonth,
  noActPricing,
  type ActPricing,
  type ExpenseMonth,
  type MailActNature,
} from './depenses.ts'
import { readExpenseSettings, type ExpenseSettings, type ExpenseSettingsInput } from './depenses-reglages.ts'
import { clientExpenseSettings } from './schema-depenses.ts'

/**
 * « Mes dépenses » en base (ADR 081) : les réglages du centre, et ce que
 * chaque entreprise du compte a consommé, mois par mois.
 *
 * Les sources sont lues par les mêmes requêtes que le registre des
 * consommations (`consommations-queries.ts`), filtrées sur le centre **et**
 * sur les entreprises du compte (ADR 019 : MySQL ne filtre pas les lectures).
 * Rien ne s'écrit : le registre, lui, ne se remplit qu'au passage du CRM.
 */

/* ------------------------------------------------------------------------ */
/* Réglages                                                                 */
/* ------------------------------------------------------------------------ */

export async function expenseSettings(): Promise<ExpenseSettings> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        showExpenses: clientExpenseSettings.showExpenses,
        estimateMailActs: clientExpenseSettings.estimateMailActs,
        historyMonths: clientExpenseSettings.historyMonths,
        note: clientExpenseSettings.note,
      })
      .from(clientExpenseSettings)
      .where(eq(clientExpenseSettings.tenantId, tenantId))
      .limit(1),
  )
  return readExpenseSettings(row)
}

/** Crée ou remplace le réglage du centre : une ligne par centre. */
export async function saveExpenseSettings(input: ExpenseSettingsInput, staffMemberId: string): Promise<void> {
  const tenantId = currentTenantId()
  const values = { ...input, updatedBy: staffMemberId }
  await withTenant(tenantId, (tx) =>
    tx
      .insert(clientExpenseSettings)
      .values({ tenantId, ...values })
      .onDuplicateKeyUpdate({ set: values }),
  )
}

/* ------------------------------------------------------------------------ */
/* Les dépenses d'un compte                                                 */
/* ------------------------------------------------------------------------ */

/** Service du catalogue de chaque acte du courrier (ADR 024, 037, 044). */
const actServiceCodes: Record<MailActNature, string> = {
  mail_opening: serviceCodes.mailOpening,
  mail_pages: serviceCodes.mailPage,
  mail_scan: serviceCodes.mailScan,
  mail_forward: serviceCodes.mailForwarding,
}

/**
 * Les dépenses des entreprises du compte, pour chacun des `months` (mois du
 * centre, du plus récent au plus ancien) : frais fixes de leurs contrats et
 * prestations, chiffrées comme le centre le règle.
 */
export async function loadClientExpenses(
  accounts: readonly ClientAccount[],
  options: { months: readonly string[]; timeZone: string; now?: Date; estimateMailActs: boolean },
): Promise<ExpenseMonth[]> {
  if (accounts.length === 0 || options.months.length === 0) return []
  const now = options.now ?? new Date()
  const { timeZone } = options
  const sorted = [...options.months].sort()
  const first = sorted[0]!
  const last = sorted.at(-1)!
  const from = monthRangeUtc(first, timeZone).startsAt
  const to = monthRangeUtc(last, timeZone).endsAt
  const tenantId = currentTenantId()
  const clientIds = accounts.map((account) => account.clientId)

  const { includedPages, sources, pricing } = await inClientSpace(accounts, async (tx) => {
    const [tenant] = await tx
      .select({ includedPages: tenants.mailOpeningIncludedPages })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
    const included = tenant?.includedPages ?? 0

    // Une requête à la fois : la transaction n'a qu'une connexion.
    const found: ConsumptionSource[] = [
      ...(await bookingSources(
        tx,
        tenantId,
        and(
          inArray(bookings.clientId, clientIds),
          eq(bookings.kind, 'booking'),
          eq(bookings.status, 'confirmed'),
          gte(bookings.startsAt, from),
          lt(bookings.startsAt, to),
          sql`not ${coveredByProposal}`,
        ),
      )),
      ...(await openingSources(
        tx,
        tenantId,
        and(
          inArray(mailItems.clientId, clientIds),
          isNull(mailItems.deletedAt),
          gte(mailItems.openedAt, from),
          lt(mailItems.openedAt, to),
        ),
      )),
      ...(await pageSources(
        tx,
        tenantId,
        and(
          inArray(mailItems.clientId, clientIds),
          isNull(mailItems.deletedAt),
          gt(mailScans.pageCount, included),
          // Comme le registre : le contenu numérisé à l'ouverture seulement.
          or(isNull(mailScans.mailRequestId), eq(mailRequests.kind, 'open_and_scan')),
          gte(mailItems.openedAt, from),
          lt(mailItems.openedAt, to),
        ),
      )),
    ]
    for (const nature of ['mail_scan', 'mail_forward'] as const) {
      found.push(
        ...(await requestSources(
          tx,
          tenantId,
          nature,
          and(
            inArray(mailRequests.clientId, clientIds),
            eq(mailRequests.status, 'done'),
            isNull(mailItems.deletedAt),
            isNotNull(mailRequests.completedAt),
            gte(mailRequests.completedAt, from),
            lt(mailRequests.completedAt, to),
          ),
        )),
      )
    }

    if (!options.estimateMailActs) return { includedPages: included, sources: found, pricing: noActPricing }

    const serviceRows = await tx
      .select({
        id: services.id,
        code: services.code,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
        currency: services.currency,
      })
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          inArray(services.code, Object.values(actServiceCodes)),
          isNull(services.deletedAt),
        ),
      )
    const subscriptionRows = serviceRows.length
      ? await tx
          .select({
            id: subscribedServices.id,
            clientId: subscribedServices.clientId,
            serviceId: subscribedServices.serviceId,
            startsOn: subscribedServices.startsOn,
            endsOn: subscribedServices.endsOn,
            unitPriceCents: subscribedServices.unitPriceCents,
            discountBp: subscribedServices.discountBp,
            vatRateBp: subscribedServices.vatRateBp,
            currency: subscribedServices.currency,
            includedQuantity: subscribedServices.includedQuantity,
          })
          .from(subscribedServices)
          .where(
            and(
              eq(subscribedServices.tenantId, tenantId),
              inArray(subscribedServices.clientId, clientIds),
              inArray(
                subscribedServices.serviceId,
                serviceRows.map((service) => service.id),
              ),
              isNull(subscribedServices.deletedAt),
              // Celles d'un contrat engagé, ou sans contrat : la règle de l'annonce.
              or(
                isNull(subscribedServices.contractId),
                sql`exists (
                  select 1 from contracts as k
                   where k.tenant_id = ${subscribedServices.tenantId}
                     and k.id = ${subscribedServices.contractId}
                     and k.deleted_at is null
                     and k.status in ('active', 'terminated'))`,
              ),
            ),
          )
      : []

    const catalogue: ActPricing['catalogue'] = {}
    const subscriptions: Record<string, Partial<Record<MailActNature, ActSubscription[]>>> = {}
    for (const nature of Object.keys(actServiceCodes) as MailActNature[]) {
      const service = serviceRows.find((row) => row.code === actServiceCodes[nature])
      if (!service) continue
      const entry: ActCatalogueService = {
        id: service.id,
        unitPriceCents: service.unitPriceCents,
        vatRateBp: service.vatRateBp,
        currency: service.currency,
      }
      catalogue[nature] = entry
      for (const row of subscriptionRows.filter((candidate) => candidate.serviceId === service.id)) {
        const forClient = (subscriptions[row.clientId] ??= {})
        ;(forClient[nature] ??= []).push({
          id: row.id,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          unitPriceCents: row.unitPriceCents,
          discountBp: row.discountBp,
          vatRateBp: row.vatRateBp,
          currency: row.currency,
          includedQuantity: row.includedQuantity,
        })
      }
    }
    return { includedPages: included, sources: found, pricing: { estimate: true, catalogue, subscriptions } }
  })

  const lastDay = addDaysToIsoDate(`${addMonthsToIsoMonth(last, 1)}-01`, -1)
  const contracts = await listContractFeesForAccounts(accounts, `${first}-01`, lastDay)

  return options.months.map((month) =>
    buildExpenseMonth({ month, contracts, sources, context: { timeZone, includedPages, now, pricing } }),
  )
}
