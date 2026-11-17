'use client'

import { useActionState, useId, useRef, useState } from 'react'

import { compressPhoto, PhotoDecodeError } from '../etats-des-lieux/compression.ts'
import { depositClientDocumentAction, type DepositState } from './pieces-compte-actions.ts'
import { DOCUMENT_ACCEPT, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_PHOTOS } from './pieces-regles.ts'

/**
 * Une pièce se lit : 2 400 px sur le grand côté, comme une page de courrier
 * (ADR 055), et une qualité qui garde le texte d'un Kbis net.
 */
const PHOTO_MAX_EDGE = 2400
const PHOTO_QUALITY = 0.85

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/** `DataTransfer` constructible : le champ peut recevoir les photos préparées. */
function canReplaceFiles(): boolean {
  try {
    new DataTransfer()
    return true
  } catch {
    return false
  }
}

/**
 * Dépôt d'une pièce justificative depuis l'espace client (ADR 075).
 *
 * Le champ de fichier reste un vrai champ du formulaire : sans JavaScript, il
 * envoie ce qui y est choisi et le serveur contrôle tout. Avec, chaque photo
 * est préparée dans le navigateur avant l'envoi (`compressPhoto`) : réduite,
 * réencodée en JPEG — une photo HEIC d'iPhone le devient là où le navigateur
 * sait la lire —, sans métadonnées EXIF ni position GPS. Plusieurs photos
 * (recto et verso) sont réunies en un seul PDF par le serveur. Un PDF se
 * joint seul.
 *
 * Rendu pour chaque pièce, déposable ou non (`open`) : le composant reste en
 * place quand la pièce passe à « reçue », et garde le message de succès que
 * le dépôt a rendu.
 *
 * Mobile d'abord : cibles de 44 px, une colonne.
 */
export function DepositForm({
  clientId,
  kindCode,
  kindLabel,
  replacing,
  open,
}: {
  clientId: string
  kindCode: string
  kindLabel: string
  /** Une pièce refusée est à remplacer : le bouton le dit. */
  replacing: boolean
  /** La pièce peut-elle être déposée (manquante ou refusée) ? Sinon, seul le dernier message reste. */
  open: boolean
}) {
  const [state, formAction, pending] = useActionState<DepositState, FormData>(depositClientDocumentAction, null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState('')
  const [problem, setProblem] = useState('')
  const id = useId()
  const inputId = `${id}-fichier`

  async function prepare(files: File[]) {
    const input = inputRef.current
    setProblem('')
    setPrepared('')
    if (!input || files.length === 0 || !canReplaceFiles()) return
    if (files.some(isPdf)) {
      if (files.length > 1) {
        setProblem('Un PDF se dépose seul. Choisissez soit un PDF, soit une ou plusieurs photos.')
        input.value = ''
        return
      }
      setPrepared(files[0].size > DOCUMENT_MAX_BYTES ? '' : `PDF prêt : ${files[0].name}.`)
      if (files[0].size > DOCUMENT_MAX_BYTES) {
        setProblem('Le PDF dépasse 10 Mo. Enregistrez-le en qualité réduite, ou photographiez le document.')
        input.value = ''
      }
      return
    }
    if (files.length > DOCUMENT_MAX_PHOTOS) {
      setProblem(`Au plus ${DOCUMENT_MAX_PHOTOS} photos à la fois. Au-delà, envoyez un PDF.`)
      input.value = ''
      return
    }
    setBusy(true)
    // Tant que les photos se préparent, le formulaire ne part pas.
    input.setCustomValidity('Les photos sont en cours de préparation. Patientez un instant.')
    const transfer = new DataTransfer()
    const failures: string[] = []
    for (const [index, file] of files.entries()) {
      try {
        const { blob } = await compressPhoto(file, { maxEdge: PHOTO_MAX_EDGE, quality: PHOTO_QUALITY })
        transfer.items.add(new File([blob], `photo-${index + 1}.jpg`, { type: 'image/jpeg' }))
      } catch (caught) {
        failures.push(
          `${file.name} : ${caught instanceof PhotoDecodeError ? caught.message : 'cette photo n’a pas pu être préparée. Reprenez-la.'}`,
        )
      }
    }
    input.files = transfer.files
    input.setCustomValidity('')
    setBusy(false)
    if (failures.length > 0) {
      input.value = ''
      setProblem(failures.join(' '))
      return
    }
    const count = transfer.files.length
    setPrepared(count > 1 ? `${plural(count, 'photo')} prêtes, réunies en un seul PDF au dépôt.` : 'Photo prête.')
  }

  const describedBy = `${id}-aide${problem ? ` ${id}-probleme` : ''}`

  return (
    // `contents` : le message reste à sa place quand le formulaire disparaît,
    // sans ajouter d'écart dans la carte.
    <div className="contents">
      {open && (
        <form action={formAction} className="flex flex-col gap-3" aria-label={`Déposer : ${kindLabel}`}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="kind" value={kindCode} />
          <div>
            <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
              {replacing ? 'Nouveau fichier' : 'Fichier'}{' '}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </label>
            <input
              ref={inputRef}
              id={inputId}
              name="fichier"
              type="file"
              accept={DOCUMENT_ACCEPT}
              multiple
              required
              aria-required="true"
              aria-describedby={describedBy}
              disabled={busy || pending}
              onChange={(event) => void prepare([...(event.currentTarget.files ?? [])])}
              className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <p id={`${id}-aide`} className="mt-1 text-xs text-muted-foreground">
              Un PDF, ou une ou plusieurs photos (recto et verso, par exemple). 10 Mo au plus.
            </p>
            <p aria-live="polite" className="mt-1 text-xs text-foreground empty:hidden">
              {busy ? 'Préparation des photos…' : prepared}
            </p>
            {problem && (
              <p id={`${id}-probleme`} role="alert" className="mt-1 text-xs text-destructive">
                {problem}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={busy || pending}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 sm:self-start"
          >
            {pending ? 'Envoi…' : replacing ? 'Déposer la nouvelle pièce' : 'Déposer la pièce'}
          </button>
        </form>
      )}
      {/* Hors du formulaire : la région existe avant le message, qui est donc annoncé. */}
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {!pending && state?.ok}
      </p>
      {open && !pending && state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  )
}
