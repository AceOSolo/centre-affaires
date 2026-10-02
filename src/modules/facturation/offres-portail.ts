import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { sendCentreMessage } from '../notifications/message-centre.ts'
import { notificationDeliveries } from '../notifications/schema.ts'
import { priceOffer, type OfferQuote } from './offres-prix.ts'
import { loadOfferCatalogueInTransaction, toOfferInput, type OfferWithItems } from './offres-queries.ts'
import { offerItems, offers, type BillingPeriod } from './schema.ts'

/**
 * L'offre groupée dans l'espace client (R23, ADR 036) : le client voit les
 * offres que le centre y présente (`offers.client_visible`), chiffrées par le
 * moteur de la vague 2 (`priceOffer`, au catalogue du jour), et en demande une
 * en une action. La demande part à l'accueil (`offer_requested`, ADR 038) ;
 * le journal des envois en est la trace, sans table de demandes : l'accueil
 * en tire le contrat (ADR 028). Rien n'engage le client sans l'équipe.
 */

/** Une offre telle que le client la voit : nom, conditions, lignes et prix d'une période. */
export type PortalOffer = {
  id: string
  name: string
  description: string | null
  billingPeriod: BillingPeriod
  commitmentMonths: number | null
  quote: OfferQuote
}

/**
 * Offres présentées dans l'espace client, sous la portée du compte. Les
 * offres et le catalogue n'ont pas de client : la portée ne les restreint
 * pas, mais rien d'autre n'est lu.
 */
export async function listPortalOffers(
  accounts: readonly ClientAccount[],
  today: string,
): Promise<PortalOffer[]> {
  if (accounts.length === 0) return []
  return inClientSpace(accounts, async (tx) => {
    const rows = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.clientVisible, true), isNull(offers.deletedAt)))
      .orderBy(asc(offers.name))
    if (rows.length === 0) return []
    const items = await tx
      .select()
      .from(offerItems)
      .where(
        and(
          inArray(
            offerItems.offerId,
            rows.map((offer) => offer.id),
          ),
          isNull(offerItems.deletedAt),
        ),
      )
      .orderBy(asc(offerItems.position), asc(offerItems.id))
    const catalogue = await loadOfferCatalogueInTransaction(tx, today)
    return rows.flatMap((offer) => {
      const withItems: OfferWithItems = {
        ...offer,
        items: items.filter((item) => item.offerId === offer.id),
      }
      // Une offre sans ligne n'a rien à montrer.
      if (withItems.items.length === 0) return []
      return [
        {
          id: offer.id,
          name: offer.name,
          description: offer.description,
          billingPeriod: offer.billingPeriod,
          commitmentMonths: offer.commitmentMonths,
          quote: priceOffer(toOfferInput(withItems), catalogue),
        },
      ]
    })
  })
}

/** Délai pendant lequel une seconde demande de la même offre par la même entreprise est inutile. */
export const OFFER_REQUEST_COOLDOWN_DAYS = 7

/**
 * Dernière demande de cette offre par cette entreprise, si elle date de moins
 * de `OFFER_REQUEST_COOLDOWN_DAYS` jours. Lue sous `withTenant()` : un message
 * au centre est invisible sous portée client (ADR 038) ; seule sa date, celle
 * de la demande de l'entreprise elle-même, revient à l'écran.
 */
export async function recentOfferRequest(clientId: string, offerId: string): Promise<Date | undefined> {
  if (!isUuid(clientId) || !isUuid(offerId)) return undefined
  const since = new Date(Date.now() - OFFER_REQUEST_COOLDOWN_DAYS * 86_400_000)
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ sentAt: notificationDeliveries.sentAt })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.event, 'offer_requested'),
          eq(notificationDeliveries.clientId, clientId),
          eq(notificationDeliveries.relatedType, 'offer'),
          eq(notificationDeliveries.relatedId, offerId),
          gte(notificationDeliveries.sentAt, since),
        ),
      )
      .orderBy(desc(notificationDeliveries.sentAt))
      .limit(1),
  )
  return row?.sentAt
}

/** Message à l'accueil : qui demande quelle offre, et où préparer le contrat. */
export function offerRequestedMessage(facts: {
  centreName: string
  clientName: string
  memberName: string
  offerName: string
  link?: string
}): { subject: string; text: string; variables: Record<string, string> } {
  return {
    subject: `Offre demandée : ${facts.offerName} — ${facts.clientName}`,
    text:
      `${facts.memberName} (${facts.clientName}) demande l’offre « ${facts.offerName} » depuis son ` +
      'espace client.\n\nPréparez le contrat depuis l’offre et revenez vers le client : rien ne ' +
      'l’engage tant que le contrat n’est pas signé.' +
      (facts.link ? `\n\nPréparer le contrat : ${facts.link}` : '') +
      `\n\n—\n${facts.centreName}`,
    variables: {
      centre: facts.centreName,
      client: facts.clientName,
      personne: facts.memberName,
      offre: facts.offerName,
      lien: facts.link ?? '',
    },
  }
}

/** Une offre présentée dans l'espace, relue sous la portée du compte. */
export async function findPortalOffer(
  accounts: readonly ClientAccount[],
  offerId: string,
): Promise<{ id: string; name: string } | undefined> {
  if (accounts.length === 0 || !isUuid(offerId)) return undefined
  const [row] = await inClientSpace(accounts, (tx) =>
    tx
      .select({ id: offers.id, name: offers.name })
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.clientVisible, true), isNull(offers.deletedAt)))
      .limit(1),
  )
  return row
}

/**
 * Transmet la demande d'une offre à l'accueil et la journalise. Le journal
 * est la trace de la demande : son écriture qui échoue fait échouer la
 * demande, que le client recommencera.
 */
export async function requestOffer(input: {
  account: ClientAccount
  memberName: string
  offer: { id: string; name: string }
}): Promise<void> {
  const tenant = await currentTenant()
  const query = new URLSearchParams({ offre: input.offer.id, client: input.account.clientId })
  const message = offerRequestedMessage({
    centreName: tenant.name,
    clientName: input.account.clientName,
    memberName: input.memberName,
    offerName: input.offer.name,
    link: appUrl(`/contrats/nouveau/offre?${query.toString()}`),
  })
  await sendCentreMessage({
    event: 'offer_requested',
    clientId: input.account.clientId,
    related: { type: 'offer', id: input.offer.id },
    ...message,
  })
}

/** Une demande d'offre, telle que l'accueil la traite dans « Demandes ». */
export type OfferRequestRow = {
  deliveryId: string
  sentAt: Date
  clientId: string
  clientName: string
  offerId: string
  offerName: string
  /** Contrat tiré de l'offre pour ce client depuis la demande : la demande est traitée. */
  contract: { id: string; reference: string } | null
}

/** Combien de jours de demandes d'offre « Demandes » montre. */
export const OFFER_REQUEST_LIST_DAYS = 90

/**
 * Offres demandées depuis l'espace client ces derniers jours, la plus récente
 * d'abord, avec le contrat que l'accueil en a tiré pour ce client depuis, le
 * cas échéant. Back-office seul (`withTenant()`).
 */
export async function listOfferRequests(): Promise<OfferRequestRow[]> {
  const since = new Date(Date.now() - OFFER_REQUEST_LIST_DAYS * 86_400_000)
  return withTenant(currentTenantId(), async (tx) => {
    const rows = await tx
      .select({
        deliveryId: notificationDeliveries.id,
        sentAt: notificationDeliveries.sentAt,
        clientId: clients.id,
        clientName: clients.name,
        offerId: offers.id,
        offerName: offers.name,
      })
      .from(notificationDeliveries)
      .innerJoin(clients, eq(clients.id, notificationDeliveries.clientId))
      .innerJoin(offers, eq(offers.id, notificationDeliveries.relatedId))
      .where(
        and(
          eq(notificationDeliveries.event, 'offer_requested'),
          eq(notificationDeliveries.relatedType, 'offer'),
          gte(notificationDeliveries.sentAt, since),
        ),
      )
      .orderBy(desc(notificationDeliveries.sentAt))
      .limit(100)
    if (rows.length === 0) return []
    const drawn = await tx
      .select({
        id: contracts.id,
        reference: contracts.reference,
        clientId: contracts.clientId,
        offerId: contracts.offerId,
        createdAt: contracts.createdAt,
      })
      .from(contracts)
      .where(
        and(
          inArray(
            contracts.offerId,
            [...new Set(rows.map((row) => row.offerId))],
          ),
          isNull(contracts.deletedAt),
          sql`${contracts.createdAt} >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(contracts.createdAt))
    return rows.map((row) => {
      const contract = drawn.find(
        (candidate) =>
          candidate.offerId === row.offerId &&
          candidate.clientId === row.clientId &&
          candidate.createdAt >= row.sentAt,
      )
      return { ...row, contract: contract ? { id: contract.id, reference: contract.reference } : null }
    })
  })
}
