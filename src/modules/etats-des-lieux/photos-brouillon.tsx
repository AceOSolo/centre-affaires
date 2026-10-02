'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'

import { useRouter } from 'next/navigation'

import {
  captionInspectionPhotoAction,
  removeInspectionPhotoAction,
  uploadInspectionPhotoAction,
} from './actions.ts'
import { compressPhoto, PhotoDecodeError } from './compression.ts'
import { dangerSmallButton, fieldClass, smallButton } from './styles.ts'

export type DraftPhoto = {
  id: string
  caption: string | null
  width: number
  height: number
}

/**
 * Photos d'un champ (ou d'ensemble) sur un brouillon d'état des lieux : dépôt,
 * légende, retrait.
 *
 * Chaque photo est compressée **dans le navigateur** avant de partir
 * (`compression.ts`) puis envoyée seule : une connexion de téléphone qui
 * flanche ne perd que la photo en cours. Le serveur vérifie, chiffre et
 * dépose. Aucun `<form>` ici : ce bloc vit à l'intérieur du formulaire de
 * saisie, et ses contrôles n'ont pas de `name` — ils ne partent pas avec lui.
 */
export function DraftPhotos({
  inspectionId,
  fieldId,
  subject,
  photos,
  photoBase,
}: {
  inspectionId: string
  fieldId: string | null
  /** Ce que les photos montrent : « Carrosserie », « l’ensemble ». */
  subject: string
  photos: DraftPhoto[]
  photoBase: string
}) {
  const router = useRouter()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()

  async function upload(files: FileList) {
    const list = [...files]
    if (list.length === 0) return
    setBusy(true)
    setErrors([])
    const failures: string[] = []
    let sent = 0
    for (const [index, file] of list.entries()) {
      const rank = list.length > 1 ? ` ${index + 1} sur ${list.length}` : ''
      try {
        setStatus(`Compression de la photo${rank}…`)
        const compressed = await compressPhoto(file)
        setStatus(`Envoi de la photo${rank}…`)
        const data = new FormData()
        data.set('inspectionId', inspectionId)
        if (fieldId) data.set('fieldId', fieldId)
        data.set('photo', new File([compressed.blob], 'photo.jpg', { type: compressed.blob.type }))
        const result = await uploadInspectionPhotoAction(data)
        if (result.error) failures.push(`${file.name} : ${result.error}`)
        else sent += 1
      } catch (error) {
        failures.push(
          `${file.name} : ${
            error instanceof PhotoDecodeError
              ? error.message
              : 'envoi impossible. Vérifiez la connexion, puis réessayez.'
          }`,
        )
      }
    }
    setBusy(false)
    setErrors(failures)
    setStatus(
      sent === 0
        ? 'Aucune photo ajoutée.'
        : `${sent} photo${sent > 1 ? 's' : ''} ajoutée${sent > 1 ? 's' : ''}.`,
    )
    if (inputRef.current) inputRef.current.value = ''
    if (sent > 0) startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-3">
      {photos.length > 0 && (
        <ul className="flex flex-wrap gap-4">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <DraftPhotoItem
                inspectionId={inspectionId}
                photo={photo}
                alt={photo.caption ?? `Photo ${index + 1} — ${subject}`}
                href={`${photoBase}/${photo.id}`}
                onChanged={() => startTransition(() => router.refresh())}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          className={`${smallButton} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent`}
        >
          {busy ? 'Envoi en cours…' : `Ajouter des photos — ${subject}`}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept="image/*"
            multiple
            disabled={busy}
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files)
            }}
            className="sr-only"
          />
        </label>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {status}
        </p>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="list-disc rounded-md border border-destructive/30 bg-destructive/5 py-2 pl-8 pr-4 text-xs text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DraftPhotoItem({
  inspectionId,
  photo,
  alt,
  href,
  onChanged,
}: {
  inspectionId: string
  photo: DraftPhoto
  alt: string
  href: string
  onChanged: () => void
}) {
  const captionId = useId()
  const [caption, setCaption] = useState(photo.caption ?? '')
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const removeRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)

  // Le focus suit le bouton qui remplace celui qu'on vient d'actionner.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
    else if (asked.current) removeRef.current?.focus()
    asked.current = confirming
  }, [confirming])

  async function saveCaption() {
    setPending(true)
    const result = await captionInspectionPhotoAction(inspectionId, photo.id, caption)
    setPending(false)
    setMessage(result.error ? { text: result.error, error: true } : { text: 'Légende enregistrée.', error: false })
    if (!result.error) onChanged()
  }

  async function remove() {
    setPending(true)
    const result = await removeInspectionPhotoAction(inspectionId, photo.id)
    setPending(false)
    if (result.error) {
      setMessage({ text: result.error, error: true })
      setConfirming(false)
      return
    }
    onChanged()
  }

  return (
    <figure className="flex w-48 flex-col gap-2">
      <a href={href} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {/* Les dimensions réservent la place : pas de saut au chargement. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- photo déchiffrée et journalisée par la route, pas d'optimisation d'image */}
        <img
          src={href}
          alt={alt}
          width={photo.width}
          height={photo.height}
          loading="lazy"
          className="h-32 w-full object-cover"
        />
        <span className="sr-only"> (ouvrir en grand dans un nouvel onglet)</span>
      </a>
      <figcaption className="flex flex-col gap-1">
        <label htmlFor={captionId} className="text-xs font-medium">
          Légende
        </label>
        <input
          id={captionId}
          value={caption}
          maxLength={500}
          onChange={(event) => setCaption(event.target.value)}
          onKeyDown={(event) => {
            // Entrée enregistre la légende, pas le formulaire de saisie qui l'entoure.
            if (event.key === 'Enter') {
              event.preventDefault()
              void saveCaption()
            }
          }}
          className={`${fieldClass} px-2 py-1 text-xs`}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={saveCaption}
            disabled={pending}
            aria-label={`Enregistrer la légende de la photo : ${alt}`}
            className={smallButton}
          >
            Enregistrer la légende
          </button>
          {confirming ? (
            <>
              <button ref={confirmRef} type="button" onClick={remove} disabled={pending} className={dangerSmallButton}>
                {pending ? 'Retrait…' : 'Confirmer le retrait'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={smallButton}>
                Garder
              </button>
            </>
          ) : (
            <button
              ref={removeRef}
              type="button"
              onClick={() => setConfirming(true)}
              disabled={pending}
              aria-label={`Retirer la photo : ${alt}`}
              className={dangerSmallButton}
            >
              Retirer
            </button>
          )}
        </div>
        {message && (
          <p role={message.error ? 'alert' : 'status'} className={`text-xs ${message.error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {message.text}
          </p>
        )}
      </figcaption>
    </figure>
  )
}
