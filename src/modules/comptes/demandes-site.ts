import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { accountHasPassword, prepareInvitationLink } from '../../lib/auth/invitation.ts'
import { authUsers } from '../../lib/auth/schema.ts'
import type { Auth } from '../../lib/auth/server.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers } from '../clients/schema.ts'
import { proposals } from '../facturation/schema-devis.ts'
import {
  notifyRequestReceived,
  type Requester,
  type RequesterAccount,
  type SiteRequestRef,
} from '../notifications/declencheurs-comptes.ts'
import type { NotificationOutcome, NotifyOptions } from '../notifications/moteur.ts'
import { bookings } from '../reservations/schema.ts'
import { activeBan } from './comptes.ts'

/**
 * Demandes déposées sur la page publique par un visiteur (ADR 068) : un
 * accusé de réception, avec le lien pour créer son espace, et la demande
 * retrouvée dans cet espace à la première entrée.
 *
 * Le lien n'est offert qu'à une adresse qui n'a encore aucun lien avec le
 * centre — exactement celle qui recevra sa propre fiche à la première entrée
 * (`ensureSignupClient`, `inscription.ts`). Une adresse déjà connue (équipe,
 * accès à une entreprise, même retiré ; compte qui a déjà un mot de passe ;
 * compte suspendu) reçoit l'accusé seul : l'équipe lui répond, et la
 * rattache à la validation comme avant.
 */

const transactionTenant = () => tenantContext.getStore() ?? DEFAULT_TENANT_ID

/**
 * La suite à proposer au demandeur, et son lien au besoin. Le compte est créé
 * ici, sans mot de passe, avec le nom et la raison sociale donnés : la fiche
 * client, née à la première entrée, portera cette raison sociale.
 */
export async function requesterAccount(
  requester: Requester,
  options: { database?: Database; tenantId?: string; auth?: Auth; now?: Date } = {},
): Promise<RequesterAccount> {
  const tenantId = options.tenantId ?? currentTenantId()
  const email = requester.email.trim().toLowerCase()
  const known = await withTenant(
    tenantId,
    async (tx) => {
      const [member] = await tx
        .select({ id: clientMembers.id })
        .from(clientMembers)
        .where(and(eq(clientMembers.tenantId, tenantId), eq(clientMembers.email, email)))
        .limit(1)
      if (member) return true
      const [staff] = await tx
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(and(eq(staffMembers.tenantId, tenantId), eq(staffMembers.email, email)))
        .limit(1)
      if (staff) return true
      const [account] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email))
      return account ? Boolean(await activeBan(tx, account.id)) : false
    },
    options.database,
  )
  if (known || (await accountHasPassword(email, { auth: options.auth }))) return { kind: 'existing' }
  const link = await prepareInvitationLink(
    { email, name: requester.name, companyName: requester.company },
    { auth: options.auth, now: options.now },
  )
  return { kind: 'invite', link }
}

/**
 * Accusé de réception d'une demande du site. Une suite qui ne peut pas être
 * préparée (authentification non configurée) n'empêche pas l'accusé : il
 * part seul. Ne lève jamais.
 */
export async function sendRequestReceived(
  request: SiteRequestRef,
  options: NotifyOptions & { auth?: Auth } = {},
): Promise<NotificationOutcome | null> {
  return notifyRequestReceived(request, {
    ...options,
    async prepareAccount(requester) {
      try {
        return await requesterAccount(requester, options)
      } catch (error) {
        console.error('Suite de la demande non préparée : l’accusé de réception part seul', error)
        return undefined
      }
    },
  })
}

/**
 * Rattache à la fiche qui vient d'être créée pour un compte les demandes du
 * site faites à son adresse et restées sans entreprise : la personne les
 * retrouve dans son espace (« Mes réservations »). Appelée par
 * `ensureSignupClient`, dans sa transaction, l'adresse étant confirmée.
 *
 * - **Réservations** : toutes, quel que soit leur état — une demande refusée
 *   se retrouve aussi. Les principales d'abord, puis leur matériel en option,
 *   qui doit être au nom du client de sa principale (`CA018`). Pas celles
 *   dont le demandeur a été anonymisé.
 * - **Devis** : seulement les brouillons. Un devis validé ne change plus de
 *   destinataire (`CA016`) : Dolibarr reprend ce que le centre a validé.
 *
 * Rend le nombre de réservations et de devis rattachés.
 */
export async function attachSiteRequests(
  tx: Transaction,
  clientId: string,
  email: string,
): Promise<{ bookings: number; proposals: number }> {
  const tenantId = transactionTenant()
  const address = email.trim().toLowerCase()
  const pending = and(
    eq(bookings.tenantId, tenantId),
    isNull(bookings.clientId),
    eq(bookings.kind, 'booking'),
    eq(bookings.requesterEmail, address),
    isNull(bookings.requesterAnonymizedAt),
  )
  type Header = [{ affectedRows: number }]
  const [mains] = (await tx
    .update(bookings)
    .set({ clientId })
    .where(and(pending, isNull(bookings.parentBookingId)))) as unknown as Header
  const [options] = (await tx
    .update(bookings)
    .set({ clientId })
    .where(and(pending, isNotNull(bookings.parentBookingId)))) as unknown as Header
  const [drafts] = (await tx
    .update(proposals)
    .set({ clientId })
    .where(
      and(
        eq(proposals.tenantId, tenantId),
        isNull(proposals.clientId),
        eq(proposals.status, 'draft'),
        eq(proposals.requesterEmail, address),
      ),
    )) as unknown as Header
  return {
    bookings: Number(mains?.affectedRows ?? 0) + Number(options?.affectedRows ?? 0),
    proposals: Number(drafts?.affectedRows ?? 0),
  }
}
