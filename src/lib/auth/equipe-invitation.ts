import { and, desc, eq, inArray } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import type { InvitationDelivery } from '../../modules/clients/invitation-etat.ts'
import { notifyStaffInvited } from '../../modules/notifications/declencheurs-comptes.ts'
import type { NotificationOutcome, NotifyOptions } from '../../modules/notifications/moteur.ts'
import { notificationDeliveries } from '../../modules/notifications/schema.ts'
import { currentTenantId } from '../tenant.ts'
import { STAFF_INVITATION_CALLBACK, accountHasPassword, prepareInvitationLink } from './invitation.ts'
import type { Auth } from './server.ts'

/**
 * Invitation d'une personne que la direction ou un exploitant vient
 * d'ajouter à l'équipe (ADR 068) : le lien pour choisir son mot de passe,
 * valable sept jours, qui mène au back-office. Renvoyée depuis l'écran Équipe
 * tant que la personne ne s'est pas connectée.
 *
 * Une personne qui a déjà un mot de passe (elle est aussi cliente du centre)
 * le garde : le message l'invite à se connecter avec lui, sans lien. Un lien
 * qui ne peut pas être préparé n'empêche pas le message : il part sans, et
 * renvoie à « Mot de passe oublié ». Ne lève jamais.
 */
export async function sendStaffInvitation(
  staffMemberId: string,
  options: NotifyOptions & { auth?: Auth } = {},
): Promise<NotificationOutcome | null> {
  return notifyStaffInvited(staffMemberId, {
    ...options,
    async prepareLink(member) {
      try {
        if (await accountHasPassword(member.email, { auth: options.auth })) return undefined
        return await prepareInvitationLink(
          { email: member.email, name: member.fullName },
          { auth: options.auth, callback: STAFF_INVITATION_CALLBACK },
        )
      } catch (error) {
        console.error('Lien d’invitation de l’équipe non préparé : l’invitation part sans lui', error)
        return undefined
      }
    },
  })
}

/**
 * Dernière invitation de chaque membre, lue au journal des messages
 * (`staff_invited`) : ce que l'écran Équipe en dit, avec les mêmes règles que
 * la fiche du client (`clients/invitation-etat.ts`).
 */
export async function latestStaffInvitations(
  memberIds: readonly string[],
  options: { database?: Database; tenantId?: string } = {},
): Promise<Map<string, InvitationDelivery>> {
  const latest = new Map<string, InvitationDelivery>()
  if (memberIds.length === 0) return latest
  const tenantId = options.tenantId ?? currentTenantId()
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({
          memberId: notificationDeliveries.relatedId,
          status: notificationDeliveries.status,
          sentAt: notificationDeliveries.sentAt,
        })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.tenantId, tenantId),
            eq(notificationDeliveries.event, 'staff_invited'),
            eq(notificationDeliveries.relatedType, 'staff_member'),
            inArray(notificationDeliveries.relatedId, [...memberIds]),
          ),
        )
        .orderBy(desc(notificationDeliveries.sentAt), desc(notificationDeliveries.id)),
    options.database,
  )
  for (const row of rows) {
    if (row.memberId && !latest.has(row.memberId)) latest.set(row.memberId, { status: row.status, sentAt: row.sentAt })
  }
  return latest
}
