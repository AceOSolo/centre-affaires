import { and, desc, eq, inArray } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import { prepareInvitationLink } from '../../lib/auth/invitation.ts'
import type { Auth } from '../../lib/auth/server.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { notifyMemberInvited } from '../notifications/declencheurs-clients.ts'
import type { NotificationOutcome, NotifyOptions } from '../notifications/moteur.ts'
import { notificationDeliveries } from '../notifications/schema.ts'
import type { InvitationDelivery } from './invitation-etat.ts'

/**
 * Invitation d'une personne que le centre vient d'inscrire sur une fiche
 * client (ADR 015, ADR 059) : l'accès existe, et voici le lien pour choisir
 * son mot de passe, valable sept jours (`lib/auth/invitation.ts`). Renvoyée
 * depuis la fiche tant que la personne ne s'est pas connectée.
 *
 * Envoyée par le moteur de notifications (ADR 038), événement
 * `member_invited` : modèle du centre ou texte par défaut
 * (`notifications/catalogue.ts`), journal des envois. Un lien qui ne peut pas
 * être préparé n'empêche pas le message : il part sans, et renvoie à « Mot de
 * passe oublié ». Ne lève jamais.
 */
export async function sendInvitation(
  clientId: string,
  email: string,
  options: NotifyOptions & { auth?: Auth } = {},
): Promise<NotificationOutcome | null> {
  return notifyMemberInvited(clientId, email, {
    ...options,
    // Préparé une fois l'accès retrouvé sur la fiche : un accès retiré entre-temps ne crée pas de compte.
    async prepareLink(member) {
      try {
        return await prepareInvitationLink({ email: member.email, name: member.fullName }, { auth: options.auth })
      } catch (error) {
        console.error('Lien d’invitation non préparé : l’invitation part sans lui', error)
        return undefined
      }
    },
  })
}

/**
 * Dernière invitation de chaque accès, lue au journal des messages : ce que
 * la fiche du client en dit (`invitation-etat.ts`). Un accès sans ligne n'a
 * pas d'invitation au journal.
 */
export async function latestInvitations(
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
            eq(notificationDeliveries.event, 'member_invited'),
            eq(notificationDeliveries.relatedType, 'client_member'),
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
