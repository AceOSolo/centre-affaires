'use client'

import Image from 'next/image'
import { useEffect, useId, useRef, useState } from 'react'

import { MailIcon } from '../../components/ui/icons.tsx'

/**
 * Photo de l'enveloppe d'un pli, côté équipe (ADR 057) : une vignette qui
 * s'agrandit, pour savoir quel pli ouvrir, numériser ou réexpédier.
 *
 * Servie par la route protégée des numérisations (`/courrier/scans/…`), qui
 * la déchiffre et inscrit chaque consultation au journal d'accès, comme pour
 * le client (ADR 015, ADR 020) : la vignette est une consultation, son
 * agrandissement en est une autre. Jamais d'optimiseur d'images ni de copie
 * en cache. La place est réservée : rien ne saute au chargement.
 *
 * L'agrandissement est un `<dialog>` natif (comme `ConfirmDialog`) : la page
 * derrière devient inerte, Échap ferme, le focus revient à la vignette. La
 * grande image n'est demandée qu'à l'ouverture. Un PDF ne se montre pas en
 * vignette : un lien l'ouvre dans un nouvel onglet.
 */
export function EnvelopeZoom({
  scanId,
  contentType,
  label,
  details,
  size = 'small',
}: {
  scanId: string | null
  contentType: string | null
  /** « Enveloppe du pli de Delta Industries reçu le 4 nov. 2026 à 09:12 ». */
  label: string
  /** Ce qui aide à retrouver le pli, répété sous la grande image. */
  details?: readonly string[]
  size?: 'small' | 'large'
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // Échap, « Fermer » ou clic à côté : le focus revient à la vignette.
    const onClose = () => {
      setOpen(false)
      triggerRef.current?.focus()
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  const box = size === 'small' ? 'h-16 w-24' : 'aspect-[4/3] w-full max-w-sm'

  if (!scanId) {
    return (
      <span
        className={`flex shrink-0 flex-col items-center justify-center gap-1 rounded-md bg-muted text-center text-xs text-muted-foreground ${box}`}
      >
        <MailIcon size={20} />
        Pas de photo
      </span>
    )
  }

  const href = `/courrier/scans/${scanId}`
  if (contentType === 'application/pdf') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener"
        aria-label={`${label} (PDF, nouvel onglet)`}
        className={`flex shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted text-xs font-medium text-primary hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${box}`}
      >
        <MailIcon size={20} />
        Enveloppe (PDF)
      </a>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true)
          dialogRef.current?.showModal()
        }}
        className={`group relative block shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border bg-muted transition-colors duration-150 ease-out hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${box}`}
      >
        <Image src={href} alt={`${label} — agrandir`} fill unoptimized sizes={size === 'small' ? '96px' : '384px'} className="object-cover" />
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClick={(event) => {
          // Un clic sur le fond (le dialogue lui-même, hors de son contenu) ferme.
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-3xl rounded-xl border border-border bg-white p-4 text-foreground shadow-lg backdrop:bg-foreground/50 sm:p-6"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {label}
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Fermer
            </button>
          </div>
          {details && details.length > 0 && (
            <p className="text-sm text-muted-foreground">{details.join(' · ')}</p>
          )}
          {/* La hauteur est réservée avant que l'image n'arrive. */}
          <div className="relative h-[65vh] w-full overflow-hidden rounded-lg bg-muted">
            {open && <Image src={href} alt={label} fill unoptimized sizes="(min-width: 768px) 720px, 100vw" className="object-contain" />}
          </div>
          <a
            href={href}
            target="_blank"
            rel="noopener"
            className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Ouvrir la photo dans un nouvel onglet
          </a>
        </div>
      </dialog>
    </>
  )
}
