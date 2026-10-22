'use client'

import { useEffect, useRef, useState } from 'react'

import { XIcon } from '../../components/ui/icons.tsx'
import { CameraIcon } from './icones.tsx'
import { mailKindLabels } from './labels.ts'
import { preparePhoto, putFiles, type PhotoPage } from './photos-field.tsx'
import { photoCountError, photoFieldName } from './saisie-groupee-regles.ts'
import type { MailKind } from './schema.ts'

// `relative` : le champ invisible (`sr-only`, positionné) reste dans le cadre
// défilant du tableau, sinon il élargit la page sur un téléphone.
const buttonClass =
  'relative inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-white px-2 py-1 text-xs font-medium text-foreground hover:bg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:opacity-50'

/** « Lettre 2 », « Colis » : le pli auquel va une photo, quand la ligne mêle plusieurs types. */
function slotLabels(slots: MailKind[]): string[] {
  return slots.map((kind, index) => {
    const same = slots.filter((other) => other === kind).length
    const rank = slots.slice(0, index + 1).filter((other) => other === kind).length
    return same > 1 ? `${mailKindLabels[kind]} ${rank}` : mailKindLabels[kind]
  })
}

/**
 * Photos des enveloppes d'une ligne de la saisie groupée (ADR 055) : une par
 * pli, qui vont aux plis dans l'ordre des colonnes (`envelopeSlots`).
 *
 * Les pages vivent au-dessus du tableau (`MailCountsForm`) : un envoi refusé
 * — une case mal remplie — remonte le tableau sans perdre les photos. Le
 * champ de fichier `p.<clientId>` reste un vrai champ du formulaire ; chaque
 * ajout, retrait ou remontage y remet toutes les photos de la ligne.
 */
export function RowPhotos({
  clientId,
  clientName,
  slots,
  pages,
  enhanced,
  error,
  onChange,
  onBusy,
}: {
  clientId: string
  clientName: string
  /** Les plis de la ligne, dans l'ordre où les photos leur vont. */
  slots: MailKind[]
  pages: PhotoPage[]
  enhanced: boolean
  /** Refus du serveur pour ce champ. */
  error?: string
  onChange: (clientId: string, update: (current: PhotoPage[]) => PhotoPage[]) => void
  onBusy: (clientId: string, busy: boolean) => void
}) {
  const name = photoFieldName(clientId)
  const carrierRef = useRef<HTMLInputElement>(null)
  const pagesRef = useRef(pages)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [failures, setFailures] = useState<string[]>([])

  useEffect(() => {
    pagesRef.current = pages
    putFiles(carrierRef.current, pages)
  }, [pages])

  useEffect(() => {
    // React vide le formulaire après un envoi refusé : les photos y reviennent.
    const form = carrierRef.current?.form
    const refill = () => setTimeout(() => putFiles(carrierRef.current, pagesRef.current))
    form?.addEventListener('reset', refill)
    return () => form?.removeEventListener('reset', refill)
  }, [])

  async function add(files: File[]) {
    if (!enhanced || files.length === 0) return
    setBusy(true)
    onBusy(clientId, true)
    setFailures([])
    const prepared: PhotoPage[] = []
    const refused: string[] = []
    for (const [index, file] of files.entries()) {
      setStatus(`Préparation de la photo${files.length > 1 ? ` ${index + 1} sur ${files.length}` : ''}…`)
      const result = await preparePhoto(file, `enveloppe-${pagesRef.current.length + prepared.length + 1}.jpg`)
      if (result.page) prepared.push(result.page)
      else refused.push(result.failure)
    }
    const count = pagesRef.current.length + prepared.length
    onChange(clientId, (current) => [...current, ...prepared])
    setBusy(false)
    onBusy(clientId, false)
    setFailures(refused)
    setStatus(`${count} photo${count > 1 ? 's' : ''} pour ${clientName}.`)
  }

  function remove(page: PhotoPage, position: number) {
    if (page.preview) URL.revokeObjectURL(page.preview)
    onChange(clientId, (current) => current.filter((other) => other.key !== page.key))
    setStatus(`Photo ${position} retirée pour ${clientName}.`)
    // Le bouton disparaît avec sa photo : le focus revient au champ.
    carrierRef.current?.focus()
  }

  const labels = slotLabels(slots)
  const mixed = new Set(slots).size > 1
  const excess = pages.length > slots.length ? photoCountError(pages.length, slots.length) : undefined
  const describedBy = [error && `${name}-error`, excess && `${name}-excess`].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {enhanced && (
          // Téléphone ou tablette : l'appareil photo s'ouvre directement, un pli après l'autre.
          <label className={`${buttonClass} hidden pointer-coarse:inline-flex`}>
            <CameraIcon size={16} />
            <span className="sr-only">Photographier une enveloppe — {clientName}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              className="sr-only"
              onChange={(event) => {
                const picked = [...(event.currentTarget.files ?? [])]
                event.currentTarget.value = ''
                void add(picked)
              }}
            />
          </label>
        )}
        <label className={buttonClass}>
          {busy ? 'Préparation…' : 'Joindre'}
          <span className="sr-only"> des photos d’enveloppe — {clientName}</span>
          <input
            ref={carrierRef}
            id={name}
            name={name}
            type="file"
            accept="image/*"
            multiple
            disabled={busy}
            aria-invalid={error || excess ? true : undefined}
            aria-describedby={describedBy}
            className="sr-only"
            onChange={(event) => {
              if (!enhanced) return
              const picked = [...(event.currentTarget.files ?? [])]
              // Le navigateur remplace la sélection : les photos déjà jointes y reviennent.
              if (picked.length === 0) putFiles(carrierRef.current, pagesRef.current)
              else void add(picked)
            }}
          />
        </label>
      </div>

      {pages.length > 0 && (
        <ol aria-label={`Photos d’enveloppe — ${clientName}`} className="flex flex-wrap gap-2 pt-1">
          {pages.map((page, index) => {
            const slot = labels[index]
            const subject = `Enveloppe ${index + 1}${slot ? ` (${slot})` : ''} — ${clientName}`
            return (
              <li key={page.key} className="flex flex-col items-center gap-0.5">
                <span className="relative">
                  {page.preview && (
                    // eslint-disable-next-line @next/next/no-img-element -- aperçu local du navigateur, avant tout envoi
                    <img
                      src={page.preview}
                      alt={subject}
                      className="h-12 w-10 rounded-sm border border-border bg-muted object-cover"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => remove(page, index + 1)}
                    aria-label={`Retirer la photo ${subject}`}
                    className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-border bg-white text-destructive hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <XIcon size={12} />
                  </button>
                </span>
                {mixed && slot && <span className="text-[11px] leading-tight text-muted-foreground">{slot}</span>}
              </li>
            )
          })}
        </ol>
      )}

      <p aria-live="polite" className="text-xs text-muted-foreground empty:hidden">
        {status}
      </p>
      {excess && (
        <p id={`${name}-excess`} className="max-w-48 text-xs text-destructive">
          {excess}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="max-w-48 text-xs text-destructive">
          {error}
        </p>
      )}
      {failures.length > 0 && (
        <ul role="alert" className="max-w-48 list-disc pl-4 text-xs text-destructive">
          {failures.map((failure, index) => (
            <li key={`${index}-${failure}`}>{failure}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
