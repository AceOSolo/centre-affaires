import { can, permissionsOf } from '../../../../lib/auth/permissions.ts'
import { staffAccess } from '../../../../lib/auth/staff.ts'
import { inboxFeed } from '../../../../modules/notifications/cloche-queries.ts'

// La cloche lit l'état du moment : jamais de mise en cache.
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * Cloche de l'équipe (ADR 059, ADR 070) : le nombre de demandes à traiter et
 * les plus récentes, pour le membre connecté, que la cloche du back-office
 * interroge toutes les minutes et à chaque navigation (`cloche.tsx`). Pas de
 * websocket.
 *
 * Hors de `proxy.ts` : sans membre de l'équipe, la route répond 401 au lieu de
 * rediriger, pour que la cloche se taise plutôt que de charger une page de
 * connexion. Gardée par `notifications.consulter`, comme la cloche dans la
 * coque ; chaque file se borne ensuite aux droits du rôle (`inboxFeed`).
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
  const feed = await inboxFeed(permissionsOf(member.role))
  return Response.json(feed, { headers: noStore })
}
