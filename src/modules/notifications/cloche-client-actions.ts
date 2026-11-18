'use server'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { markClientBellRead } from './cloche-client-queries.ts'

/**
 * Cloche de l'espace client (ADR 077) : marquer lu. Chaque action revérifie
 * le compte — une action serveur s'invoque par son identifiant depuis
 * n'importe quelle page (ADR 008) — et ne retient que les messages des
 * entreprises du compte (`markClientBellRead`, puis `CA023` en base).
 *
 * Pas de `revalidatePath` : la cloche tient son état dans le navigateur et
 * relit la route à la navigation qui suit. Recharger la page en cours
 * pendant que la personne la quitte pour la nouveauté ouverte ne servirait à
 * rien.
 */

/** Une nouveauté ouverte depuis la cloche. */
export async function markClientNotificationReadAction(id: string): Promise<{ marked: number }> {
  const { accounts } = await requireClientAccount()
  if (typeof id !== 'string' || !isUuid(id)) return { marked: 0 }
  return { marked: await markClientBellRead(accounts, [id]) }
}

/** « Tout marquer comme lu » : les nouveautés de la période. */
export async function markAllClientNotificationsReadAction(): Promise<{ marked: number }> {
  const { accounts } = await requireClientAccount()
  return { marked: await markClientBellRead(accounts, 'toutes') }
}
