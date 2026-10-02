import { timingSafeEqual } from 'node:crypto'

import { withTenant } from '../../../../db/index.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { purgeExpiredMail } from '../../../../modules/courrier/conservation.ts'

/**
 * Purge planifiée du courrier arrivé au terme de sa conservation (ADR 015).
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

  const result = await withTenant(currentTenantId(), (tx) => purgeExpiredMail(tx, deleteObject))
  return Response.json(result)
}
