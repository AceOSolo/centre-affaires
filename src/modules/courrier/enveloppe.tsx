import Image from 'next/image'

import { MailIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'

/**
 * Photo de l'enveloppe d'un pli, dans l'espace client (R19, R21).
 *
 * Jamais d'URL publique ni d'optimiseur d'images : la vignette est servie par
 * la route protégée des numérisations (`/compte/scans/…`), qui la déchiffre
 * et inscrit chaque consultation au journal d'accès (ADR 015, ADR 020). La
 * place est réservée : rien ne saute au chargement. Un PDF ne se montre pas
 * en vignette : un lien le remplace.
 */
export function EnvelopeThumbnail({
  envelopeScanId,
  envelopeContentType,
  receivedAt,
  timeZone,
  size,
}: {
  envelopeScanId: string | null
  envelopeContentType: string | null
  receivedAt: Date
  timeZone: string
  size: 'small' | 'large'
}) {
  const box = size === 'small' ? 'h-20 w-28' : 'aspect-[4/3] w-full max-w-sm'
  if (!envelopeScanId) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ${box}`}>
        <MailIcon size={24} />
        <span className="sr-only">Pas de photo de l’enveloppe</span>
      </span>
    )
  }
  const href = `/compte/scans/${envelopeScanId}`
  const label = `Enveloppe du pli reçu le ${formatDateTime(receivedAt, timeZone)}`
  if (envelopeContentType === 'application/pdf') {
    return (
      <a
        href={href}
        aria-label={`Enveloppe (PDF) du pli reçu le ${formatDateTime(receivedAt, timeZone)}`}
        className={`flex shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted text-xs font-medium text-primary hover:bg-white ${box}`}
      >
        <MailIcon size={24} />
        Enveloppe (PDF)
      </a>
    )
  }
  return (
    <a
      href={href}
      aria-label={`${label}, en grand`}
      className={`relative block shrink-0 overflow-hidden rounded-md border border-border bg-muted ${box}`}
    >
      <Image src={href} alt={label} fill unoptimized sizes={size === 'small' ? '112px' : '384px'} className="object-cover" />
    </a>
  )
}
