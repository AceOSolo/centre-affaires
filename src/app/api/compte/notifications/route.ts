import { currentTimeZone } from '../../../../lib/tenant.ts'
import { clientAccess } from '../../../../modules/clients/session.ts'
import { countMailForAccounts } from '../../../../modules/courrier/non-lus.ts'
import type { ClientBellFeed } from '../../../../modules/notifications/cloche-client.ts'
import { clientBellFeed } from '../../../../modules/notifications/cloche-client-queries.ts'

// La cloche lit l'état du moment : jamais de mise en cache.
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * Cloche de l'espace client (ADR 077) : les nouveautés de la personne
 * connectée, et le nombre de plis non lus de l'onglet « Courrier », que la
 * cloche interroge toutes les minutes et à chaque navigation
 * (`cloche-client.tsx`). Pas de websocket.
 *
 * Hors de `proxy.ts` : sans compte client, la route répond 401 au lieu de
 * rediriger, pour que la cloche se taise plutôt que de charger une page de
 * connexion. La portée est celle du compte (`clientAccess`, ADR 019).
 */
export async function GET() {
  const access = await clientAccess()
  if (access.status !== 'client') {
    return Response.json({ error: 'Réservé aux clients du centre.' }, { status: 401, headers: noStore })
  }
  const [feed, mail] = await Promise.all([
    currentTimeZone().then((timeZone) => clientBellFeed(access.accounts, { timeZone })),
    countMailForAccounts(access.accounts),
  ])
  const body: ClientBellFeed = { ...feed, unreadMail: mail.unread }
  return Response.json(body, { headers: noStore })
}
