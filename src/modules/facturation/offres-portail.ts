import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts, offerRequests, type OfferRequestStatus } from '../contrats/schema.ts'
import { notifyOfferRequested } from '../notifications/declencheurs-clients.ts'
import type { NotifyOptions } from '../notifications/moteur.ts'
import { priceOffer, type OfferQuote } from './offres-prix.ts'
import { loadOfferCatalogueInTransaction, toOfferInput, type OfferWithItems } from './offres-queries.ts'
import { offerItems, offers, type BillingPeriod } from './schema.ts'

/**
 * L'offre groupée dans l'espace client (R23, ADR 036) : le client voit les
 * offres que le centre y présente (`offers.client_visible`), chiffrées par le
 * moteur de la vague 2 (`priceOffer`, au catalogue du jour), et en demande une
 * en une action. La demande est une ligne de `offer_requests` (ADR 041) : le
 * client la retrouve dans son historique, l'accueil la traite dans
 * « Demandes » — il en tire le contrat (ADR 028) ou l'écarte, avec un motif.
 * L'accueil en est prévenu (`offer_requested`, ADR 038). Rien n'engage le
 * client sans l'équipe.
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
 * La demande à traiter de cette offre par cette entreprise, s'il y en a une :
 * une seconde ne ferait que doubler la première. Lue sous la portée du compte.
 */
export async function openOfferRequest(
  accounts: readonly ClientAccount[],
  clientId: string,
  offerId: string,
): Promise<{ id: string; requestedAt: Date } | undefined> {
  if (accounts.length === 0 || !isUuid(clientId) || !isUuid(offerId)) return undefined
  const [row] = await inClientSpace(accounts, (tx) =>
    tx
      .select({ id: offerRequests.id, requestedAt: offerRequests.requestedAt })
      .from(offerRequests)
      .where(
        and(
          eq(offerRequests.clientId, clientId),
          eq(offerRequests.offerId, offerId),
          eq(offerRequests.status, 'requested'),
        ),
      )
      .limit(1),
  )
  return row
}

/** Ce qu'il est advenu d'un dépôt : une demande nouvelle, ou celle qui attend déjà. */
export type OfferRequestOutcome = { status: 'created' | 'already'; requestedAt: Date }

/**
 * Dépose la demande d'une offre (R23, R24 ; ADR 041) : une ligne de
 * `offer_requests`, sous la portée du compte, au nom de la personne
 * connectée. C'est la trace de la demande, que le client retrouve dans son
 * historique et que l'accueil traite dans « Demandes ». La base refuse une
 * offre qui n'est pas présentée dans l'espace (`CA013`) et n'en garde qu'une à
 * traiter par entreprise et par offre.
 *
 * L'accueil est ensuite prévenu par le moteur de notifications
 * (`offer_requested`, ADR 038). Un message qui ne part pas ne défait pas la
 * demande : elle est déjà dans la file.
 */
export async function requestOffer(
  input: { account: ClientAccount; offer: { id: string; name: string } },
  options: NotifyOptions = {},
): Promise<OfferRequestOutcome> {
  const { account, offer } = input
  const [created] = await inClientSpace(
    [account],
    (tx) =>
      tx
        .insert(offerRequests)
        .values({ clientId: account.clientId, offerId: offer.id, requestedByMemberId: account.memberId })
        // Une demande à traiter existe déjà (`offer_requests_open_key`) : rien de plus.
        .onConflictDoNothing()
        .returning({ requestedAt: offerRequests.requestedAt }),
    options.database,
  )
  if (!created) {
    const [open] = await inClientSpace(
      [account],
      (tx) =>
        tx
          .select({ requestedAt: offerRequests.requestedAt })
          .from(offerRequests)
          .where(
            and(
              eq(offerRequests.clientId, account.clientId),
              eq(offerRequests.offerId, offer.id),
              eq(offerRequests.status, 'requested'),
            ),
          )
          .limit(1),
      options.database,
    )
    return { status: 'already', requestedAt: open?.requestedAt ?? new Date() }
  }
  await notifyOfferRequested(
    { offerId: offer.id, clientId: account.clientId, memberId: account.memberId },
    options,
  )
  return { status: 'created', requestedAt: created.requestedAt }
}

/** Une demande d'offre, telle que l'accueil la traite dans « Demandes ». */
export type OfferRequestRow = {
  id: string
  requestedAt: Date
  clientId: string
  clientName: string
  offerId: string
  offerName: string
  /** La personne de l'entreprise qui l'a déposée. */
  requestedByName: string | null
  status: OfferRequestStatus
  /** Contrat tiré de l'offre pour ce client : la demande est traitée. */
  contract: { id: string; reference: string } | null
  closedAt: Date | null
  closedByName: string | null
  /** Motif d'une demande écartée, montré au client. */
  dismissalReason: string | null
}

/** Combien de jours « Demandes » garde à l'écran une demande d'offre traitée. */
export const OFFER_REQUEST_LIST_DAYS = 90

/** Longueur maximale du motif d'une demande écartée : celle de la base. */
export const DISMISSAL_REASON_MAX_LENGTH = 500

/**
 * Offres demandées depuis l'espace client : toutes celles à traiter, les plus
 * anciennes d'abord, puis celles traitées ces derniers jours — contrat établi
 * ou demande écartée. Back-office seul (`withTenant()`).
 */
export async function listOfferRequests(): Promise<OfferRequestRow[]> {
  const since = new Date(Date.now() - OFFER_REQUEST_LIST_DAYS * 86_400_000)
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: offerRequests.id,
        requestedAt: offerRequests.requestedAt,
        clientId: clients.id,
        clientName: clients.name,
        offerId: offers.id,
        offerName: offers.name,
        requestedByName: sql<string | null>`coalesce(${clientMembers.fullName}, ${clientMembers.email})`,
        status: offerRequests.status,
        contractId: offerRequests.contractId,
        contractReference: contracts.reference,
        closedAt: offerRequests.closedAt,
        closedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
        dismissalReason: offerRequests.dismissalReason,
      })
      .from(offerRequests)
      .innerJoin(clients, eq(clients.id, offerRequests.clientId))
      .innerJoin(offers, eq(offers.id, offerRequests.offerId))
      .innerJoin(clientMembers, eq(clientMembers.id, offerRequests.requestedByMemberId))
      .leftJoin(contracts, eq(contracts.id, offerRequests.contractId))
      .leftJoin(staffMembers, eq(staffMembers.id, offerRequests.closedByStaffId))
      .where(or(eq(offerRequests.status, 'requested'), gte(offerRequests.closedAt, since)))
      .orderBy(
        sql`case when ${offerRequests.status} = 'requested' then 0 else 1 end`,
        sql`case when ${offerRequests.status} = 'requested' then ${offerRequests.requestedAt} end asc`,
        desc(offerRequests.closedAt),
      )
      .limit(200),
  )
  return rows.map(({ contractId, contractReference, ...row }) => ({
    ...row,
    contract: contractId && contractReference ? { id: contractId, reference: contractReference } : null,
  }))
}

/**
 * Écarte une demande d'offre à traiter, au nom du membre de l'équipe, avec un
 * motif facultatif que le client lit dans son historique. Rend faux si la
 * demande est introuvable ou déjà traitée.
 */
export async function dismissOfferRequest(
  id: string,
  staffMemberId: string,
  reason: string | null,
): Promise<boolean> {
  if (!isUuid(id)) return false
  const updated = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(offerRequests)
      .set({ status: 'dismissed', closedByStaffId: staffMemberId, dismissalReason: reason?.trim() || null })
      .where(and(eq(offerRequests.id, id), eq(offerRequests.status, 'requested')))
      .returning({ id: offerRequests.id }),
  )
  return updated.length > 0
}
