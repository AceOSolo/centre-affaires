import { INVITATION_JOURS } from '../../lib/auth/messages.ts'
import { formatDateTime } from '../../lib/dates.ts'
import type { NotificationDeliveryStatus } from '../notifications/schema.ts'

/**
 * État d'un accès à l'espace client, tel que la fiche du client le montre
 * (ADR 059) : actif dès la première connexion, sinon invité — avec la date
 * de la dernière invitation, la fin de validité de son lien et ce qu'il est
 * devenu au journal des messages. Module pur, éprouvé seul.
 */

/** La dernière invitation de l'accès, lue au journal des messages (`member_invited`). */
export type InvitationDelivery = { status: NotificationDeliveryStatus; sentAt: Date }

export type MemberAccessState =
  | { kind: 'actif' }
  /** Aucune invitation au journal : accès ouvert avant l'ADR 059, ou journal purgé. */
  | { kind: 'sans-invitation' }
  | {
      kind: 'invite'
      sentAt: Date
      expiresAt: Date
      expired: boolean
      delivery: NotificationDeliveryStatus
    }

export function memberAccessState(
  member: { authUserId: string | null },
  last: InvitationDelivery | undefined,
  now: Date = new Date(),
): MemberAccessState {
  if (member.authUserId) return { kind: 'actif' }
  if (!last) return { kind: 'sans-invitation' }
  const expiresAt = new Date(last.sentAt.getTime() + INVITATION_JOURS * 86_400_000)
  return {
    kind: 'invite',
    sentAt: last.sentAt,
    expiresAt,
    expired: expiresAt.getTime() <= now.getTime(),
    delivery: last.status,
  }
}

/** Peut-on renvoyer l'invitation ? Tant que la personne ne s'est pas connectée. */
export function canResendInvitation(state: MemberAccessState): boolean {
  return state.kind !== 'actif'
}

/**
 * Libellé de la pastille et précision dessous, en texte : l'état ne se lit
 * jamais à la seule couleur.
 */
export function describeMemberAccess(
  state: MemberAccessState,
  timeZone: string,
): { label: string; active: boolean; detail: string | null } {
  if (state.kind === 'actif') return { label: 'Compte activé', active: true, detail: null }
  if (state.kind === 'sans-invitation') {
    return {
      label: 'En attente de connexion',
      active: false,
      detail: 'Aucune invitation au journal : renvoyez-la pour donner un lien.',
    }
  }
  const sent = formatDateTime(state.sentAt, timeZone)
  const until = formatDateTime(state.expiresAt, timeZone)
  switch (state.delivery) {
    case 'not_configured':
      return {
        label: 'Invitation non envoyée',
        active: false,
        detail: `Le ${sent}, l’envoi n’était pas configuré : aucun courriel n’est parti.`,
      }
    case 'failed':
      return {
        label: 'Échec de l’invitation',
        active: false,
        detail: `Le ${sent}, le serveur de courriel a refusé l’envoi (journal des messages).`,
      }
    case 'skipped':
      return {
        label: 'Invitation non envoyée',
        active: false,
        detail: `Le ${sent}, le message n’est pas parti (journal des messages).`,
      }
    case 'sent':
      return state.expired
        ? { label: 'Invitation expirée', active: false, detail: `Envoyée le ${sent}, lien expiré le ${until}.` }
        : { label: 'Invitée', active: false, detail: `Envoyée le ${sent}, lien valable jusqu’au ${until}.` }
  }
}
