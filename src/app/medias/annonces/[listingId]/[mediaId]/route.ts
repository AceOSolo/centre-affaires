import { can } from '../../../../../lib/auth/permissions.ts'
import { staffAccess } from '../../../../../lib/auth/staff.ts'
import { readObjectStream } from '../../../../../lib/stockage.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { listingMediaExtensions, singleByteRange } from '../../../../../modules/ressources/annonces-medias.ts'
import { findListingMediaForServing } from '../../../../../modules/ressources/annonces-queries.ts'

const notFound = () =>
  new Response('Média introuvable.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/**
 * Photo ou vidéo d'une annonce (ADR 073), servie par l'application depuis le
 * stockage européen.
 *
 * Publique quand l'annonce l'est ; d'un brouillon, l'équipe seule la voit, le
 * temps de préparer l'annonce. Hors du filtre `proxy.ts` : le site public doit
 * la charger sans session.
 *
 * Un média ne change jamais sous le même identifiant — en remplacer un, c'est
 * en ajouter un autre — : publique, la réponse se garde un an. Les vidéos se
 * servent par plages d'octets, sans quoi Safari ne les lit pas.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ listingId: string; mediaId: string }> },
) {
  const { listingId, mediaId } = await params
  if (!isUuid(listingId) || !isUuid(mediaId)) return notFound()

  const listing = await findListingMediaForServing(listingId)
  const media = listing?.media.find((item) => item.id === mediaId)
  if (!listing || !media) return notFound()

  if (!listing.visible) {
    const access = await staffAccess()
    if (access.status !== 'membre' || !can(access.member.role, 'ressources.gerer')) return notFound()
  }

  const range = singleByteRange(request.headers.get('range'))
  let object: Awaited<ReturnType<typeof readObjectStream>>
  try {
    object = await readObjectStream(media.key, range)
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'InvalidRange') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.byteSize}` } })
    }
    if (name === 'NoSuchKey') return notFound()
    throw error
  }

  const headers = new Headers({
    'Content-Type': media.contentType,
    'Content-Disposition': `inline; filename="annonce-${media.id}.${listingMediaExtensions[media.contentType]}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': listing.visible ? 'public, max-age=31536000, immutable' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (object.contentLength !== undefined) headers.set('Content-Length', String(object.contentLength))
  if (object.contentRange) headers.set('Content-Range', object.contentRange)

  return new Response(object.body, { status: object.contentRange ? 206 : 200, headers })
}
