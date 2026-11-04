'use server'

import { permissionsOf } from '../../lib/auth/permissions.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import {
  countUnreadStaffNotifications,
  markAllStaffNotificationsRead,
  markStaffNotificationRead,
} from './cloche-queries.ts'

/*
 * Actions de la cloche de l'équipe (ADR 059), gardées par le droit de
 * consulter les notifications (`notifications.consulter`, que les trois rôles
 * ont) ; ce que le membre peut marquer se borne ensuite à ce que ses droits
 * lui font voir (`kindsVisibleTo`). Lu ou non lu n'engage que lui.
 *
 * Rien n'est revalidé : la cloche met son compteur à jour avec le nombre
 * rendu, sans recharger la page.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Marque lue une notification pour le membre connecté. Rend le nombre de non lues. */
export async function markStaffNotificationReadAction(notificationId: string): Promise<number> {
  const { member } = await requirePermission('notifications.consulter')
  const reader = { id: member.id, allowed: permissionsOf(member.role) }
  // Un identifiant mal formé ne marque rien : le compte reste ce qu'il est.
  if (typeof notificationId !== 'string' || !UUID.test(notificationId)) {
    return countUnreadStaffNotifications(reader)
  }
  return markStaffNotificationRead(reader, notificationId)
}

/** Marque lues toutes les notifications du membre connecté. Rend 0. */
export async function markAllStaffNotificationsReadAction(): Promise<number> {
  const { member } = await requirePermission('notifications.consulter')
  return markAllStaffNotificationsRead({ id: member.id, allowed: permissionsOf(member.role) })
}
