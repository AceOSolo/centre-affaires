'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'

import { useRouter } from 'next/navigation'

import { ImagePlusIcon, PlayIcon } from '../../components/ui/icons.tsx'
import { compressPhoto, PhotoDecodeError } from '../etats-des-lieux/compression.ts'
import { dangerSmallButton, fieldClass, smallButton } from '../etats-des-lieux/styles.ts'
import {
  describeListingMediaAction,
  moveListingMediaAction,
  removeListingMediaAction,
  uploadListingMediaAction,
} from './annonces-medias-actions.ts'
import {
  LISTING_MEDIA_ACCEPT,
  LISTING_MEDIA_ALT_MAX,
  LISTING_VIDEO_MAX_BYTES,
  listingMediaAlt,
  listingMediaUrl,
  MAX_LISTING_MEDIA,
  type ListingMedia,
  type MediaMove,
} from './annonces-medias.ts'

/** Plus grand côté d'une photo d'annonce : net en plein écran, léger au téléphone. */
const LISTING_PHOTO_EDGE = 2400
const LISTING_PHOTO_QUALITY = 0.85

const isVideoFile = (file: File) => file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)

/**
 * Photos et vidéos d'une annonce (ADR 073) : ajout, ordre, description,
 * retrait. Ce qui est en premier ouvre la galerie de la page publique ; la
 * première photo sert de couverture dans le catalogue.
 *
 * Les photos sont réduites dans le navigateur avant de partir, comme celles
 * des états des lieux ; une vidéo part telle quelle, 20 Mo au plus. Un
 * fichier par envoi.
 */
export function AnnonceMedias({
  listingId,
  headline,
  media,
}: {
  listingId: string
  headline: string
  media: ListingMedia[]
}) {
  const router = useRouter()
  const inputId = useId()
  const hintId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const refresh = () => startTransition(() => router.refresh())
  const full = media.length >= MAX_LISTING_MEDIA

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
        let attachment: File
        if (isVideoFile(file)) {
          if (file.type === 'video/quicktime' || /\.mov$/i.test(file.name)) {
            failures.push(`${file.name} : les vidéos .mov ne se lisent pas sur tous les navigateurs. Exportez-la en MP4.`)
            continue
          }
          if (file.size > LISTING_VIDEO_MAX_BYTES) {
            failures.push(`${file.name} : la vidéo dépasse 20 Mo. Raccourcissez-la ou exportez-la en 720p.`)
            continue
          }
          setStatus(`Envoi de la vidéo${rank}…`)
          attachment = file
        } else {
          setStatus(`Préparation de la photo${rank}…`)
          const compressed = await compressPhoto(file, {
            maxEdge: LISTING_PHOTO_EDGE,
            quality: LISTING_PHOTO_QUALITY,
          })
          setStatus(`Envoi de la photo${rank}…`)
          attachment = new File([compressed.blob], 'photo.jpg', { type: compressed.blob.type })
        }
        const data = new FormData()
        data.set('listingId', listingId)
        data.set('fichier', attachment)
        const result = await uploadListingMediaAction(data)
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
      sent === 0 ? 'Aucun fichier ajouté.' : `${sent} fichier${sent > 1 ? 's' : ''} ajouté${sent > 1 ? 's' : ''}.`,
    )
    if (inputRef.current) inputRef.current.value = ''
    if (sent > 0) refresh()
  }

  return (
    <section aria-labelledby={`${inputId}-titre`} className="flex max-w-4xl flex-col gap-4">
      <div>
        <h2 id={`${inputId}-titre`} className="text-lg font-semibold tracking-tight">
          Photos et vidéos
        </h2>
        <p id={hintId} className="mt-1 text-sm text-muted-foreground">
          Elles défilent en tête de l’annonce, dans l’ordre ci-dessous. La première photo sert aussi de
          couverture dans le catalogue. Photos JPEG, PNG ou WebP ; vidéos MP4 ou WebM de 20 Mo au plus.
          {` ${media.length} sur ${MAX_LISTING_MEDIA}.`}
        </p>
      </div>

      {media.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
          Aucune photo pour l’instant. Une annonce avec trois ou quatre photos lumineuses se remarque bien
          mieux : ajoutez-en ci-dessous.
        </p>
      ) : (
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {media.map((item, index) => (
            <li key={item.id}>
              <MediaItem
                listingId={listingId}
                item={item}
                index={index}
                total={media.length}
                alt={listingMediaAlt(item, headline, index, media.length)}
                onChanged={refresh}
              />
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          aria-disabled={busy || full}
          className={`inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${busy || full ? '' : 'cursor-pointer'}`}
        >
          <ImagePlusIcon size={18} />
          {busy ? 'Envoi en cours…' : 'Ajouter des photos ou des vidéos'}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={LISTING_MEDIA_ACCEPT}
            multiple
            disabled={busy || full}
            aria-describedby={hintId}
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files)
            }}
            className="sr-only"
          />
        </label>
        {full && (
          <p className="text-sm text-muted-foreground">
            Limite atteinte : retirez un média pour en ajouter un autre.
          </p>
        )}
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>

      {errors.length > 0 && (
        <ul
          role="alert"
          className="list-disc rounded-md border border-destructive/30 bg-destructive/5 py-2 pl-8 pr-4 text-sm text-destructive"
        >
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MediaItem({
  listingId,
  item,
  index,
  total,
  alt,
  onChanged,
}: {
  listingId: string
  item: ListingMedia
  index: number
  total: number
  alt: string
  onChanged: () => void
}) {
  const altId = useId()
  const [text, setText] = useState(item.alt ?? '')
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const removeRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const src = listingMediaUrl(listingId, item)

  // Le focus suit le bouton qui remplace celui qu'on vient d'actionner.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
    else if (asked.current) removeRef.current?.focus()
    asked.current = confirming
  }, [confirming])

  async function run(action: () => Promise<{ error?: string }>, success?: string) {
    setPending(true)
    const result = await action()
    setPending(false)
    if (result.error) {
      setMessage({ text: result.error, error: true })
      setConfirming(false)
      return
    }
    if (success) setMessage({ text: success, error: false })
    onChanged()
  }

  const move = (direction: MediaMove) => run(() => moveListingMediaAction(listingId, item.id, direction))

  return (
    <figure className="flex h-full flex-col gap-2 rounded-lg border border-border bg-white p-3">
      <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
        {item.kind === 'video' ? (
          <>
            <video
              src={`${src}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              controls
              aria-label={alt}
              className="h-full w-full object-cover"
            />
            <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium text-primary">
              <PlayIcon size={12} /> Vidéo
            </span>
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- brouillon visible de l'équipe seule : l'optimiseur d'images n'a pas sa session
          <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
        )}
        {index === 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
            En premier
          </span>
        )}
      </div>

      <figcaption className="flex flex-1 flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {item.kind === 'video' ? 'Vidéo' : 'Photo'} {index + 1} sur {total}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => move('first')}
            disabled={pending || index === 0}
            aria-label={`Mettre en premier : ${alt}`}
            className={smallButton}
          >
            Mettre en premier
          </button>
          <button
            type="button"
            onClick={() => move('earlier')}
            disabled={pending || index === 0}
            aria-label={`Avancer d’une place : ${alt}`}
            className={smallButton}
          >
            ← Avancer
          </button>
          <button
            type="button"
            onClick={() => move('later')}
            disabled={pending || index === total - 1}
            aria-label={`Reculer d’une place : ${alt}`}
            className={smallButton}
          >
            Reculer →
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={altId} className="text-xs font-medium">
            Ce que montre {item.kind === 'video' ? 'la vidéo' : 'la photo'}
          </label>
          <input
            id={altId}
            value={text}
            maxLength={LISTING_MEDIA_ALT_MAX}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void run(() => describeListingMediaAction(listingId, item.id, text), 'Description enregistrée.')
              }
            }}
            className={`${fieldClass} px-2 py-1 text-xs`}
          />
          <p className="text-xs text-muted-foreground">Lu aux personnes malvoyantes. Ex. : « La salle vue depuis l’entrée ».</p>
        </div>

        <div className="mt-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run(() => describeListingMediaAction(listingId, item.id, text), 'Description enregistrée.')}
            disabled={pending}
            aria-label={`Enregistrer la description : ${alt}`}
            className={smallButton}
          >
            Enregistrer la description
          </button>
          {confirming ? (
            <>
              <button
                ref={confirmRef}
                type="button"
                onClick={() => run(() => removeListingMediaAction(listingId, item.id))}
                disabled={pending}
                className={dangerSmallButton}
              >
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
              aria-label={`Retirer : ${alt}`}
              className={dangerSmallButton}
            >
              Retirer
            </button>
          )}
        </div>
        {message && (
          <p
            role={message.error ? 'alert' : 'status'}
            className={`text-xs ${message.error ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {message.text}
          </p>
        )}
      </figcaption>
    </figure>
  )
}
