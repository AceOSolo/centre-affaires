import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'

import type { Transaction } from '../../db/index.ts'
import { withTenant } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { mailItems, mailRequests, mailScans, type MailKind } from '../courrier/schema.ts'
import type { RateUnit } from '../facturation/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import type { CrmConnectorId } from './connecteurs.ts'
import {
  consumptionDraft,
  consumptionWindow,
  isReady,
  plannedCancellations,
  sourceKey,
  type ConsumptionForCrm,
  type ConsumptionSource,
  type ConsumptionWindow,
  type LiveConsumption,
} from './consommations.ts'
import { crmConsumptions, type ConsumptionNature, type ConsumptionStatus } from './schema-consommations.ts'
import { crmConnections } from './schema.ts'
import { crmLinks } from './schema-liens.ts'

/**
 * Le registre des consommations en base (ADR 066) : le passage qui les prend
 * et les annule, la liste que le CRM lit, l'accusé de réception.
 *
 * Tout se lit et s'écrit pour le centre courant (`currentTenantId()`) — celui
 * du jeton, sous `serveCrmCall` — et chaque requête porte son filtre
 * `tenant_id` : MySQL ne filtre pas les lectures (décision 1).
 */

/* ------------------------------------------------------------------------ */
/* Lecture des sources                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Une réservation tenue par un devis vivant : le CRM la facture à partir du
 * devis (ADR 043). Le seul endroit qui le dit pour les consommations — une
 * réservation liée à une autre (matériel ajouté à une salle, lot 6) qui serait
 * chiffrée dans le devis de celle-ci s'ajoute ici.
 */
// Le matériel en option d'une salle (ADR 062) est chiffré sur le devis de
// la salle : le devis vivant de sa réservation principale le couvre aussi.
const coveredByProposal = sql<number>`exists (
  select 1 from proposals as p
   where p.tenant_id = ${bookings.tenantId}
     and (p.booking_id = ${bookings.id} or p.booking_id = ${bookings.parentBookingId})
     and p.status <> 'cancelled')`

/** Aucune consommation vivante ne tient déjà cette source : la base l'interdit de toute façon. */
function noLiveConsumption(tenantId: string, nature: ConsumptionNature, sourceIdColumn: SQLWrapper) {
  return sql`not exists (
    select 1 from crm_consumptions as c
     where c.tenant_id = ${tenantId} and c.nature = ${nature} and c.source_id = ${sourceIdColumn}
       and c.status <> 'cancelled')`
}

async function bookingSources(tx: Transaction, tenantId: string, where: SQL | undefined): Promise<ConsumptionSource[]> {
  const rows = await tx
    .select({
      sourceId: bookings.id,
      clientId: bookings.clientId,
      kind: bookings.kind,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      resourceId: bookings.resourceId,
      resourceName: resources.name,
      resourceCode: resources.code,
      resourceType: resources.resourceType,
      contractId: bookings.contractId,
      contractReference: contracts.reference,
      coveredByProposal,
      quoteUnit: bookings.quoteUnit,
      quoteQuantity: bookings.quoteQuantity,
      quoteUnitPriceCents: bookings.quoteUnitPriceCents,
      quoteDiscountBp: bookings.quoteDiscountBp,
      quoteDiscountAmountCents: bookings.quoteDiscountAmountCents,
      quoteVatRateBp: bookings.quoteVatRateBp,
      quoteCurrency: bookings.quoteCurrency,
      quoteAmountCents: bookings.quoteAmountCents,
      quotedAt: bookings.quotedAt,
    })
    .from(bookings)
    .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
    .leftJoin(contracts, and(eq(contracts.tenantId, bookings.tenantId), eq(contracts.id, bookings.contractId)))
    .where(and(eq(bookings.tenantId, tenantId), where))
  return rows.map((row) => ({
    nature: 'booking',
    sourceId: row.sourceId,
    clientId: row.clientId,
    kind: row.kind,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    resourceCode: row.resourceCode,
    resourceType: row.resourceType as ResourceType,
    contractId: row.contractId,
    contractReference: row.contractReference,
    coveredByProposal: Boolean(Number(row.coveredByProposal)),
    // Le devis est complet ou absent (`bookings_quote_complete`).
    quote:
      row.quotedAt && row.quoteUnit && row.quoteQuantity !== null && row.quoteUnitPriceCents !== null &&
      row.quoteVatRateBp !== null && row.quoteCurrency
        ? {
            unit: row.quoteUnit as RateUnit,
            quantity: row.quoteQuantity,
            unitPriceCents: row.quoteUnitPriceCents,
            discountBp: row.quoteDiscountBp,
            discountAmountCents: row.quoteDiscountAmountCents,
            vatRateBp: row.quoteVatRateBp,
            currency: row.quoteCurrency,
            amountCents: row.quoteAmountCents ?? 0,
          }
        : null,
  }))
}

async function openingSources(tx: Transaction, tenantId: string, where: SQL | undefined): Promise<ConsumptionSource[]> {
  const rows = await tx
    .select({
      sourceId: mailItems.id,
      clientId: mailItems.clientId,
      mailKind: mailItems.kind,
      receivedAt: mailItems.receivedAt,
      openedAt: mailItems.openedAt,
      deletedAt: mailItems.deletedAt,
    })
    .from(mailItems)
    .where(and(eq(mailItems.tenantId, tenantId), where))
  return rows.map((row) => ({
    nature: 'mail_opening',
    sourceId: row.sourceId,
    clientId: row.clientId,
    mailItemId: row.sourceId,
    mailKind: row.mailKind as MailKind,
    receivedAt: row.receivedAt,
    removed: row.deletedAt !== null,
    openedAt: row.openedAt,
  }))
}

async function pageSources(tx: Transaction, tenantId: string, where: SQL | undefined): Promise<ConsumptionSource[]> {
  const rows = await tx
    .select({
      sourceId: mailScans.id,
      clientId: mailItems.clientId,
      mailItemId: mailItems.id,
      mailKind: mailItems.kind,
      receivedAt: mailItems.receivedAt,
      openedAt: mailItems.openedAt,
      deletedAt: mailItems.deletedAt,
      pageCount: mailScans.pageCount,
    })
    .from(mailScans)
    .innerJoin(mailItems, and(eq(mailItems.tenantId, mailScans.tenantId), eq(mailItems.id, mailScans.mailItemId)))
    .leftJoin(mailRequests, and(eq(mailRequests.tenantId, mailScans.tenantId), eq(mailRequests.id, mailScans.mailRequestId)))
    .where(and(eq(mailScans.tenantId, tenantId), eq(mailScans.side, 'content'), where))
  return rows.map((row) => ({
    nature: 'mail_pages',
    sourceId: row.sourceId,
    clientId: row.clientId,
    mailItemId: row.mailItemId,
    mailKind: row.mailKind as MailKind,
    receivedAt: row.receivedAt,
    removed: row.deletedAt !== null,
    openedAt: row.openedAt,
    pageCount: row.pageCount,
  }))
}

async function requestSources(
  tx: Transaction,
  tenantId: string,
  nature: 'mail_scan' | 'mail_forward',
  where: SQL | undefined,
): Promise<ConsumptionSource[]> {
  const rows = await tx
    .select({
      sourceId: mailRequests.id,
      clientId: mailRequests.clientId,
      mailItemId: mailItems.id,
      mailKind: mailItems.kind,
      receivedAt: mailItems.receivedAt,
      deletedAt: mailItems.deletedAt,
      status: mailRequests.status,
      completedAt: mailRequests.completedAt,
      postageCents: mailRequests.postageCents,
      postageCurrency: mailRequests.postageCurrency,
    })
    .from(mailRequests)
    .innerJoin(mailItems, and(eq(mailItems.tenantId, mailRequests.tenantId), eq(mailItems.id, mailRequests.mailItemId)))
    .where(
      and(eq(mailRequests.tenantId, tenantId), eq(mailRequests.kind, nature === 'mail_scan' ? 'scan' : 'forward'), where),
    )
  return rows.map((row) => ({
    nature,
    sourceId: row.sourceId,
    clientId: row.clientId,
    mailItemId: row.mailItemId,
    mailKind: row.mailKind as MailKind,
    receivedAt: row.receivedAt,
    removed: row.deletedAt !== null,
    status: row.status,
    completedAt: row.completedAt,
    postageCents: row.postageCents,
    postageCurrency: row.postageCurrency,
  }))
}

/** Les sources de ces consommations, quel que soit leur état : c'est l'état qu'on vient vérifier. */
async function sourcesOf(tx: Transaction, tenantId: string, live: readonly LiveConsumption[]) {
  const ids = (nature: ConsumptionNature) => live.filter((c) => c.nature === nature).map((c) => c.sourceId)
  const load = async (nature: ConsumptionNature, read: (where: SQL) => Promise<ConsumptionSource[]>, column: Parameters<typeof inArray>[0]) => {
    const wanted = ids(nature)
    return wanted.length ? read(inArray(column, wanted)) : []
  }
  const found = [
    ...(await load('booking', (where) => bookingSources(tx, tenantId, where), bookings.id)),
    ...(await load('mail_opening', (where) => openingSources(tx, tenantId, where), mailItems.id)),
    ...(await load('mail_pages', (where) => pageSources(tx, tenantId, where), mailScans.id)),
    ...(await load('mail_scan', (where) => requestSources(tx, tenantId, 'mail_scan', where), mailRequests.id)),
    ...(await load('mail_forward', (where) => requestSources(tx, tenantId, 'mail_forward', where), mailRequests.id)),
  ]
  return new Map(found.map((source) => [sourceKey(source.nature, source.sourceId), source]))
}

/**
 * Les sources prêtes qu'aucune consommation vivante ne tient. La requête
 * dégrossit (période, état) ; `isReady` décide, la même règle que les tests
 * éprouvent seule.
 */
async function readySources(tx: Transaction, tenantId: string, window: ConsumptionWindow & { startAt: Date }) {
  const { startAt, now, mailCutoff, includedPages } = window
  const sources = [
    ...(await bookingSources(
      tx,
      tenantId,
      and(
        eq(bookings.kind, 'booking'),
        eq(bookings.status, 'confirmed'),
        isNotNull(bookings.clientId),
        gte(bookings.startsAt, startAt),
        lte(bookings.endsAt, now),
        sql`not ${coveredByProposal}`,
        noLiveConsumption(tenantId, 'booking', bookings.id),
      ),
    )),
    ...(await openingSources(
      tx,
      tenantId,
      and(
        isNull(mailItems.deletedAt),
        gte(mailItems.openedAt, startAt),
        lt(mailItems.openedAt, mailCutoff),
        noLiveConsumption(tenantId, 'mail_opening', mailItems.id),
      ),
    )),
    ...(await pageSources(
      tx,
      tenantId,
      and(
        isNull(mailItems.deletedAt),
        gt(mailScans.pageCount, includedPages),
        // Le contenu numérisé à l'ouverture : d'office, ou sur demande
        // d'ouverture. Une numérisation demandée ensuite se compte par sa
        // demande, pas à la page.
        or(isNull(mailScans.mailRequestId), eq(mailRequests.kind, 'open_and_scan')),
        gte(mailItems.openedAt, startAt),
        lt(mailItems.openedAt, mailCutoff),
        noLiveConsumption(tenantId, 'mail_pages', mailScans.id),
      ),
    )),
  ]
  // Une requête à la fois : la transaction n'a qu'une connexion.
  for (const nature of ['mail_scan', 'mail_forward'] as const) {
    sources.push(
      ...(await requestSources(
        tx,
        tenantId,
        nature,
        and(
          eq(mailRequests.status, 'done'),
          isNull(mailItems.deletedAt),
          gte(mailRequests.completedAt, startAt),
          lt(mailRequests.completedAt, mailCutoff),
          noLiveConsumption(tenantId, nature, mailRequests.id),
        ),
      )),
    )
  }
  return sources.filter((source) => isReady(source, window))
}

/* ------------------------------------------------------------------------ */
/* Le passage                                                               */
/* ------------------------------------------------------------------------ */

export type ConsumptionSync = {
  /** Date de départ réglée à l'écran (jour du centre) ; nulle : rien n'est pris. */
  from: string | null
  /** Faux sans date de départ réglée : rien n'est pris, les annulations se font quand même. */
  started: boolean
  created: number
  cancelled: number
  /** Réexpéditions faites dans un mois clos dont les frais ne sont pas relevés : elles attendent. */
  waitingPostage: number
}

/**
 * Met le registre à jour : annule ce dont la source a changé ou ne fait plus
 * de consommation, puis prend ce qui est devenu prêt. Rejouable à volonté :
 * aucune source ne fait deux consommations vivantes.
 *
 * Les passages d'un même centre se suivent : chacun verrouille le réglage du
 * centre le temps de sa transaction. L'index unique par source reste la garde
 * de dernier recours.
 */
export async function syncConsumptions(now: Date = new Date()): Promise<ConsumptionSync> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const [settings] = await tx
      .select({ from: crmConnections.consumptionsFrom })
      .from(crmConnections)
      .where(eq(crmConnections.tenantId, tenantId))
      .for('update')
    const [tenant] = await tx
      .select({ timeZone: tenants.timezone, includedPages: tenants.mailOpeningIncludedPages })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
    if (!tenant) throw new Error('Centre introuvable.')
    const window = consumptionWindow({
      from: settings?.from ?? null,
      now,
      timeZone: tenant.timeZone,
      includedPages: tenant.includedPages,
    })

    // 1. Revoir les consommations vivantes : les prêtes toutes, les transmises
    //    des derniers mois.
    const live: LiveConsumption[] = await tx
      .select({
        id: crmConsumptions.id,
        nature: crmConsumptions.nature,
        sourceId: crmConsumptions.sourceId,
        fingerprint: crmConsumptions.fingerprint,
      })
      .from(crmConsumptions)
      .where(
        and(
          eq(crmConsumptions.tenantId, tenantId),
          or(
            eq(crmConsumptions.status, 'ready'),
            and(eq(crmConsumptions.status, 'sent'), gte(crmConsumptions.occurredAt, window.reviewSentFrom)),
          ),
        ),
      )
    const cancellations = plannedCancellations(live, await sourcesOf(tx, tenantId, live))
    const byReason = new Map<string, string[]>()
    for (const { id, reason } of cancellations) byReason.set(reason, [...(byReason.get(reason) ?? []), id])
    for (const [reason, ids] of byReason) {
      await tx
        .update(crmConsumptions)
        .set({ status: 'cancelled', cancellationReason: reason })
        .where(and(eq(crmConsumptions.tenantId, tenantId), inArray(crmConsumptions.id, ids)))
    }

    // 2. Prendre ce qui est prêt, depuis la date de départ.
    const from = settings?.from ?? null
    if (!window.startAt) return { from, started: false, created: 0, cancelled: cancellations.length, waitingPostage: 0 }
    const ready = await readySources(tx, tenantId, { ...window, startAt: window.startAt })
    const drafts = ready.map((source) =>
      consumptionDraft(source, { timeZone: tenant.timeZone, includedPages: tenant.includedPages }),
    )
    for (let index = 0; index < drafts.length; index += 200) {
      await tx.insert(crmConsumptions).values(drafts.slice(index, index + 200).map((draft) => ({ tenantId, ...draft })))
    }

    const [waiting] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(mailRequests)
      .innerJoin(mailItems, and(eq(mailItems.tenantId, mailRequests.tenantId), eq(mailItems.id, mailRequests.mailItemId)))
      .where(
        and(
          eq(mailRequests.tenantId, tenantId),
          eq(mailRequests.kind, 'forward'),
          eq(mailRequests.status, 'done'),
          isNull(mailRequests.postageCents),
          isNull(mailItems.deletedAt),
          gte(mailRequests.completedAt, window.startAt),
          lt(mailRequests.completedAt, window.mailCutoff),
        ),
      )
    return {
      from,
      started: true,
      created: drafts.length,
      cancelled: cancellations.length,
      waitingPostage: Number(waiting?.count ?? 0),
    }
  })
}

/* ------------------------------------------------------------------------ */
/* Ce que le CRM lit                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Les consommations d'un statut, de la plus ancienne modification à la plus
 * récente, avec la référence dans le CRM de leur client et, pour une
 * réservation au titre d'un contrat, de ce contrat (`crm_links`).
 */
export async function listConsumptionsForCrm(
  connector: CrmConnectorId,
  filter: { status: ConsumptionStatus; since?: Date; limit: number },
): Promise<ConsumptionForCrm[]> {
  const tenantId = currentTenantId()
  const clientLink = alias(crmLinks, 'client_link')
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        consumption: crmConsumptions,
        clientName: clients.name,
        clientSiret: clients.siret,
        clientCrmId: clientLink.externalId,
      })
      .from(crmConsumptions)
      .innerJoin(clients, and(eq(clients.tenantId, crmConsumptions.tenantId), eq(clients.id, crmConsumptions.clientId)))
      .leftJoin(
        clientLink,
        and(
          eq(clientLink.tenantId, crmConsumptions.tenantId),
          eq(clientLink.connector, connector),
          eq(clientLink.entity, 'client'),
          eq(clientLink.localId, crmConsumptions.clientId),
          isNull(clientLink.removedAt),
        ),
      )
      .where(
        and(
          eq(crmConsumptions.tenantId, tenantId),
          eq(crmConsumptions.status, filter.status),
          filter.since ? gte(crmConsumptions.updatedAt, filter.since) : undefined,
        ),
      )
      .orderBy(asc(crmConsumptions.updatedAt), asc(crmConsumptions.id))
      .limit(filter.limit)

    const contractIds = [
      ...new Set(
        rows
          .map(({ consumption }) => consumption.details.contratId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ]
    const contractLinks = contractIds.length
      ? await tx
          .select({ localId: crmLinks.localId, externalId: crmLinks.externalId })
          .from(crmLinks)
          .where(
            and(
              eq(crmLinks.tenantId, tenantId),
              eq(crmLinks.connector, connector),
              eq(crmLinks.entity, 'contract'),
              inArray(crmLinks.localId, contractIds),
              isNull(crmLinks.removedAt),
            ),
          )
      : []
    const contractCrmIds = new Map(contractLinks.map((link) => [link.localId, link.externalId]))

    return rows.map(({ consumption, clientName, clientSiret, clientCrmId }) => ({
      ...consumption,
      client: { id: consumption.clientId, name: clientName, siret: clientSiret, crmId: clientCrmId },
      contractCrmId:
        typeof consumption.details.contratId === 'string'
          ? (contractCrmIds.get(consumption.details.contratId) ?? null)
          : null,
    }))
  })
}

export type ConsumptionAck = { result: 'ok' | 'introuvable' } | { result: 'refuse'; message: string }

/**
 * Le CRM a repris la consommation (`POST …/consommations/{id}/transmis`).
 * Rejouable : le même identifiant une seconde fois ne change rien. Refusé pour
 * une consommation annulée — elle ne se facture pas — ou déjà reprise sous un
 * autre identifiant.
 */
export async function markConsumptionSent(id: string, crm: { id: string; ref: string | null }): Promise<ConsumptionAck> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        status: crmConsumptions.status,
        crmId: crmConsumptions.crmId,
        cancellationReason: crmConsumptions.cancellationReason,
      })
      .from(crmConsumptions)
      .where(and(eq(crmConsumptions.tenantId, tenantId), eq(crmConsumptions.id, id)))
      .for('update')
    if (!row) return { result: 'introuvable' }
    if (row.status === 'cancelled') {
      return {
        result: 'refuse',
        message: `Consommation annulée${row.cancellationReason ? ` (${row.cancellationReason.replace(/\.$/, '')})` : ''} : ne pas la facturer.`,
      }
    }
    if (row.status === 'sent') {
      return row.crmId === crm.id
        ? { result: 'ok' }
        : { result: 'refuse', message: `Consommation déjà reprise par le CRM sous l’identifiant « ${row.crmId} ».` }
    }
    await tx
      .update(crmConsumptions)
      .set({ status: 'sent', crmId: crm.id, crmRef: crm.ref })
      .where(and(eq(crmConsumptions.tenantId, tenantId), eq(crmConsumptions.id, id), eq(crmConsumptions.status, 'ready')))
    return { result: 'ok' }
  })
}

/** Combien de consommations par statut : pour l'écran « Connexion au CRM ». */
export async function consumptionCounts(): Promise<Record<ConsumptionStatus, number>> {
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ status: crmConsumptions.status, count: sql<number>`count(*)` })
      .from(crmConsumptions)
      .where(eq(crmConsumptions.tenantId, tenantId))
      .groupBy(crmConsumptions.status),
  )
  const counts: Record<ConsumptionStatus, number> = { ready: 0, sent: 0, cancelled: 0 }
  for (const row of rows) counts[row.status] = Number(row.count)
  return counts
}
