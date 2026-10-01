import { timingSafeEqual } from 'node:crypto'

import { withTenant } from '../../../../db/index.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { purgeExpiredMail } from '../../../../modules/courrier/conservation.ts'
import { anonymizeExpiredPublicRequests } from '../../../../modules/reservations/conservation.ts'

/**
 * Purge planifiée de ce qui est arrivé au terme de sa conservation : le
 * courrier et son journal d'accès (ADR 015), les coordonnées des demandeurs de
 * la page publique (ADR 020). Les durées sont celles du centre (`tenants`).
 *
 * Appelée chaque nuit par une tâche du serveur (infra/serveur/README.md), avec
 * le jeton `MAINTENANCE_TOKEN`. Sans jeton configuré, la route n'existe pas :
 * elle ne doit jamais être joignable sans secret.
 */
function authorized(request: Request): boolean {
  const expected = process.env.MAINTENANCE_TOKEN
  if (!expected) return false
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // Comparaison à temps constant : la durée de la réponse ne doit pas
  // renseigner sur le nombre de caractères justes.
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response('Introuvable.', { status: 404 })

  const tenantId = currentTenantId()
  // Les coordonnées des demandes publiques échues d'abord (B4, ADR 020), dans
  // leur propre transaction : une panne du stockage, qui interrompt la purge
  // du courrier, ne retient pas leur effacement.
  const publicRequests = await withTenant(tenantId, anonymizeExpiredPublicRequests)
  const mail = await withTenant(tenantId, (tx) => purgeExpiredMail(tx, deleteObject))
  return Response.json({ ...mail, publicRequests })
}
