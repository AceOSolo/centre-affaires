import { and, asc, between, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { dayRangeUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { invoices, payments, type InvoiceKind } from '../facturation/schema-factures.ts'
import type { InvoiceLineKind } from '../facturation/schema-factures.ts'
import { services, type ServiceNature } from '../facturation/schema.ts'
import { bookings } from '../reservations/schema.ts'
import type { ClosurePeriod, OpeningRule } from '../ressources/ouverture.ts'
import { closures, openingHours, resources, type Resource } from '../ressources/schema.ts'
import type { OccupyingBooking } from './occupation.ts'
import type { Period } from './periode.ts'
import type { CreditedLineRef, IssuedDocument, ReceivedPayment, RevenueLine } from './revenus.ts'

/**
 * Lecture des données des indicateurs (R31). Tout est lu dans une seule
 * transaction, sous le centre courant ; les calculs sont ceux, purs et testés,
 * d'`occupation.ts` et de `revenus.ts`.
 *
 * Seuls les documents **émis** sont lus : un brouillon n'a ni numéro ni date
 * d'émission, il n'est pas encore du chiffre d'affaires (ADR 026).
 */

export type IndicatorResource = Pick<
  Resource,
  'id' | 'code' | 'name' | 'resourceType' | 'status' | 'createdAt' | 'deletedAt'
>

export type IndicatorService = {
  id: string
  name: string
  code: string | null
  nature: ServiceNature
  deletedAt: Date | null
}

export type IndicatorData = {
  /** Toutes les ressources, archivées comprises : une ligne de facture peut viser l'une d'elles. */
  resources: IndicatorResource[]
  services: IndicatorService[]
  /** Occupations de la plage observée (réservations confirmées et contrats). */
  bookings: OccupyingBooking[]
  rules: OpeningRule[]
  closures: ClosurePeriod[]
  /** Lignes des factures et avoirs émis dans la période choisie. */
  lines: RevenueLine[]
  /** Lignes créditées dans la période mais facturées avant. */
  creditedLines: Map<string, CreditedLineRef>
  /** Documents émis dans la plage observée (période et courbe d'évolution). */
  documents: IssuedDocument[]
  /** Paiements non annulés de la plage observée. */
  payments: ReceivedPayment[]
  /** Factures émises qui restent dues aujourd'hui, toutes périodes confondues. */
  outstanding: IssuedDocument[]
}

/**
 * Colonnes d'une ligne de facture, sa ressource et son service résolus.
 *
 * Une ligne porte `resource_id` et `service_id` pour les indicateurs (ADR 026).
 * Quand elle ne les porte pas, on les retrouve par sa source : la ressource de
 * la réservation, celle de la ligne de contrat, ou, pour un loyer global, celle
 * du segment d'occupation du contrat au premier jour facturé (ADR 025) ; le
 * service de la ligne de contrat ou de la souscription.
 */
const lineSelect = sql`
  select l.id::text as id,
         i.kind::text as document_kind,
         i.currency::text as currency,
         l.kind::text as kind,
         l.quantity,
         l.net_amount_cents,
         coalesce(l.resource_id, b.resource_id, cl.resource_id, seg.resource_id)::text as resource_id,
         coalesce(l.service_id, cl.service_id, ss.service_id)::text as service_id,
         l.credited_line_id::text as credited_line_id
    from invoice_lines as l
    join invoices as i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
    left join bookings as b on b.tenant_id = l.tenant_id and b.id = l.booking_id
    left join contract_lines as cl on cl.tenant_id = l.tenant_id and cl.id = l.contract_line_id
    left join subscribed_services as ss
           on ss.tenant_id = l.tenant_id and ss.id = l.subscribed_service_id
    left join contracts as k
           on k.tenant_id = l.tenant_id and k.id = l.contract_id and l.kind = 'rent'
    left join lateral (
      select s.resource_id
        from contract_segments(k) as s
       where k.id is not null and s.starts_on <= l.period_start
       order by s.starts_on desc
       limit 1
    ) as seg on true`

type LineRow = {
  id: string
  document_kind: string
  currency: string
  kind: string
  quantity: number | string
  net_amount_cents: number | string
  resource_id: string | null
  service_id: string | null
  credited_line_id: string | null
}

function toRevenueLine(row: LineRow): RevenueLine {
  return {
    id: row.id,
    documentKind: row.document_kind as InvoiceKind,
    currency: row.currency.trim(),
    kind: row.kind as InvoiceLineKind,
    quantity: Number(row.quantity),
    netAmountCents: Number(row.net_amount_cents),
    resourceId: row.resource_id,
    serviceId: row.service_id,
    creditedLineId: row.credited_line_id,
  }
}

/** Lignes émises dans la période, et celles, plus anciennes, que leurs avoirs créditent. */
async function readRevenueLines(
  tx: Transaction,
  period: Period,
): Promise<{ lines: RevenueLine[]; creditedLines: Map<string, CreditedLineRef> }> {
  const rows = (await tx.execute(sql`
    ${lineSelect}
     where i.status <> 'draft'
       and i.deleted_at is null
       and l.deleted_at is null
       and i.issue_date between ${period.from}::date and ${period.to}::date
     order by i.issue_date, i.number, l.position, l.id`)) as unknown as LineRow[]
  const lines = rows.map(toRevenueLine)

  const known = new Set(lines.map((line) => line.id))
  const missing = [
    ...new Set(
      lines
        .map((line) => line.creditedLineId)
        .filter((id): id is string => id !== null && !known.has(id)),
    ),
  ]
  const creditedLines = new Map<string, CreditedLineRef>()
  if (missing.length > 0) {
    const older = (await tx.execute(sql`
      ${lineSelect}
       where l.id in (${sql.join(
         missing.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`)) as unknown as LineRow[]
    for (const line of older.map(toRevenueLine)) {
      creditedLines.set(line.id, { kind: line.kind, resourceId: line.resourceId, serviceId: line.serviceId })
    }
  }
  return { lines, creditedLines }
}

const documentColumns = {
  kind: invoices.kind,
  currency: invoices.currency,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  totalExclTaxCents: invoices.totalExclTaxCents,
  totalInclTaxCents: invoices.totalInclTaxCents,
  paidCents: invoices.paidCents,
  creditedCents: invoices.creditedCents,
}

type DocumentRow = Omit<IssuedDocument, 'issueDate' | 'dueDate'> & {
  issueDate: string | null
  dueDate: string | null
}

function toIssuedDocument(row: DocumentRow): IssuedDocument {
  return {
    ...row,
    currency: row.currency.trim(),
    // Posées par `issue_invoice()` : jamais nulles sur un document émis
    // (contrainte `invoices_issued_complete`).
    issueDate: row.issueDate ?? '',
    dueDate: row.dueDate ?? '',
  }
}

/**
 * Tout ce qu'il faut pour l'écran des indicateurs.
 *
 * `period` : la période choisie (tableaux par ressource et par service).
 * `range` : la plage observée, qui la contient et couvre aussi la courbe
 * d'évolution (occupation, facturé, encaissé mois par mois).
 */
export async function loadIndicatorData(input: {
  period: Period
  range: Period
  timeZone: string
}): Promise<IndicatorData> {
  const { period, range, timeZone } = input
  const startsAt = dayRangeUtc(range.from, timeZone).startsAt
  const endsAt = dayRangeUtc(range.to, timeZone).endsAt

  return withTenant(currentTenantId(), async (tx) => {
    const resourceRows = await tx
      .select({
        id: resources.id,
        code: resources.code,
        name: resources.name,
        resourceType: resources.resourceType,
        status: resources.status,
        createdAt: resources.createdAt,
        deletedAt: resources.deletedAt,
      })
      .from(resources)
      .orderBy(asc(resources.resourceType), asc(resources.code), asc(resources.id))

    const serviceRows = await tx
      .select({
        id: services.id,
        name: services.name,
        code: services.code,
        nature: services.nature,
        deletedAt: services.deletedAt,
      })
      .from(services)
      .orderBy(asc(services.name), asc(services.id))

    // Bornes `[)` du planning : une occupation qui finit à minuit pile le
    // premier jour n'en fait pas partie.
    const bookingRows = await tx
      .select({
        resourceId: bookings.resourceId,
        kind: bookings.kind,
        status: bookings.status,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          inArray(bookings.kind, ['booking', 'contract']),
          lt(bookings.startsAt, endsAt),
          gt(bookings.endsAt, startsAt),
        ),
      )

    const rules = await tx
      .select({
        resourceId: openingHours.resourceId,
        weekday: openingHours.weekday,
        opensAt: openingHours.opensAt,
        closesAt: openingHours.closesAt,
      })
      .from(openingHours)

    const closureRows = await tx
      .select({ resourceId: closures.resourceId, startsOn: closures.startsOn, endsOn: closures.endsOn })
      .from(closures)
      .where(and(lte(closures.startsOn, range.to), gte(closures.endsOn, range.from)))

    const { lines, creditedLines } = await readRevenueLines(tx, period)

    const issued = and(ne(invoices.status, 'draft'), isNull(invoices.deletedAt))
    const documentRows = await tx
      .select(documentColumns)
      .from(invoices)
      .where(and(issued, between(invoices.issueDate, range.from, range.to)))

    const paymentRows = await tx
      .select({ currency: payments.currency, paidOn: payments.paidOn, amountCents: payments.amountCents })
      .from(payments)
      .where(and(isNull(payments.cancelledAt), between(payments.paidOn, range.from, range.to)))

    // Seules les factures non soldées ont un reste dû : `paid` et `cancelled`
    // sont déduits par la base de ce qu'il ne reste rien (ADR 026).
    const outstandingRows = await tx
      .select(documentColumns)
      .from(invoices)
      .where(
        and(
          issued,
          eq(invoices.kind, 'invoice'),
          inArray(invoices.status, ['issued', 'partially_paid']),
        ),
      )

    return {
      resources: resourceRows,
      services: serviceRows,
      bookings: bookingRows,
      rules,
      closures: closureRows,
      lines,
      creditedLines,
      documents: documentRows.map(toIssuedDocument),
      payments: paymentRows.map((row) => ({ ...row, currency: row.currency.trim() })),
      outstanding: outstandingRows.map(toIssuedDocument),
    }
  })
}
