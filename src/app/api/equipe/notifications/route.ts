import { can, permissionsOf } from '../../../../lib/auth/permissions.ts'
import { staffAccess } from '../../../../lib/auth/staff.ts'
import { staffNotificationFeed } from '../../../../modules/notifications/cloche-queries.ts'

// La cloche lit l'état du moment : jamais de mise en cache.
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * Cloche de l'équipe (ADR 059) : le nombre de non lues et les dernières
 * notifications du membre connecté, que la cloche du back-office interroge
 * toutes les minutes et à chaque navigation (`cloche.tsx`). Pas de websocket.
 *
 * Hors de `proxy.ts` : sans membre de l'équipe, la route répond 401 au lieu de
 * rediriger, pour que la cloche se taise plutôt que de charger une page de
 * connexion. Même droit que les actions de la cloche (`notifications.consulter`,
 * `cloche-actions.ts`), qui seules marquent lu : elles ont leur protection
 * contre les requêtes d'un autre site.
 */
export async function GET() {
  const access = await staffAccess()
  if (access.status !== 'membre') {
    return Response.json({ error: 'Réservé à l’équipe du centre.' }, { status: 401, headers: noStore })
  }
  const { member } = access
  if (!can(member.role, 'notifications.consulter')) {
    return Response.json({ error: 'Droit insuffisant.' }, { status: 403, headers: noStore })
  }
  const feed = await staffNotificationFeed({ id: member.id, allowed: permissionsOf(member.role) })
  return Response.json(feed, { headers: noStore })
}
