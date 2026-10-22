'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { FileTextIcon } from '../../components/ui/icons.tsx'
import { compressPhoto, PhotoDecodeError } from '../etats-des-lieux/compression.ts'
import { MAX_SCAN_BYTES, MAX_SCAN_PHOTOS, MAX_SCAN_PHOTOS_BYTES, SCAN_ACCEPT } from './fichiers.ts'
import { CameraIcon } from './icones.tsx'

/**
 * Un courrier se lit : 2 400 px sur le grand côté, environ 200 dpi pour une
 * page A4, et une qualité un peu plus haute que celle d'un état des lieux.
 */
const MAIL_PHOTO_MAX_EDGE = 2400
const MAIL_PHOTO_QUALITY = 0.85

const labelClass = 'block text-sm font-medium text-foreground'
const cameraClass =
  'hidden min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-muted pointer-coarse:inline-flex has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:opacity-50'

type Page = { key: number; file: File; /** Aperçu local d'une photo ; nul pour un PDF. */ preview: string | null }

/** `DataTransfer` constructible : le champ peut garder les pages ajoutées une à une. */
let transferSupported: boolean | undefined
function supportsTransfer(): boolean {
  if (transferSupported === undefined) {
    try {
      new DataTransfer()
      transferSupported = true
    } catch {
      transferSupported = false
    }
  }
  return transferSupported
}
const noSubscription = () => () => {}

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/**
 * Photos d'un courrier, à chaque étape du back-office (ADR 055) : enveloppe à
 * l'enregistrement ou plus tard, contenu à l'ouverture, numérisation demandée.
 *
 * Le champ de fichier reste un vrai champ du formulaire, envoyé avec lui :
 * sans JavaScript, il envoie ce qui y est choisi. Avec, il garde les pages
 * ajoutées une à une — photographier la page 1, puis la 2… —, chacune
 * compressée dans le navigateur (`compressPhoto`, sans métadonnées EXIF ni
 * position GPS), et les remet dans le champ à chaque ajout. Le serveur réunit
 * plusieurs photos en un seul PDF (`readScans`). Un PDF se joint seul.
 *
 * `multiple` : plusieurs pages (le contenu) ; sinon une seule photo, qui
 * remplace la précédente (l'enveloppe).
 */
export function PhotosField({
  name,
  label,
  hint,
  error,
  required = false,
  multiple = false,
}: {
  name: string
  label: string
  hint: string
  error?: string
  required?: boolean
  multiple?: boolean
}) {
  const enhanced = useSyncExternalStore(noSubscription, supportsTransfer, () => false)
  const carrierRef = useRef<HTMLInputElement>(null)
  const pagesRef = useRef<Page[]>([])
  const keyRef = useRef(0)
  const [pages, setPages] = useState<Page[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [problems, setProblems] = useState<string[]>([])

  useEffect(() => {
    const revokeAll = () => {
      for (const page of pagesRef.current) if (page.preview) URL.revokeObjectURL(page.preview)
    }
    // React vide le formulaire après chaque envoi : les pages partent avec lui.
    const form = carrierRef.current?.form
    const clear = () => {
      revokeAll()
      pagesRef.current = []
      setPages([])
      setStatus('')
      setProblems([])
    }
    form?.addEventListener('reset', clear)
    return () => {
      form?.removeEventListener('reset', clear)
      revokeAll()
    }
  }, [])

  function summary(list: Page[]): string {
    if (list.length === 0) return ''
    if (list[0].preview === null) return `PDF prêt : ${list[0].file.name}.`
    if (!multiple) return 'Photo prête.'
    return `${plural(list.length, 'page')} ${list.length > 1 ? 'prêtes, réunies en un seul PDF au dépôt' : 'prête'}.`
  }

  /** Pose la liste des pages, et remet toutes ses pages dans le champ envoyé. */
  function apply(next: Page[]) {
    for (const page of pagesRef.current) {
      if (page.preview && !next.includes(page)) URL.revokeObjectURL(page.preview)
    }
    pagesRef.current = next
    setPages(next)
    const carrier = carrierRef.current
    if (!carrier) return
    const transfer = new DataTransfer()
    for (const page of next) transfer.items.add(page.file)
    carrier.files = transfer.files
  }

  async function add(files: File[]) {
    const carrier = carrierRef.current
    if (files.length === 0 || !carrier) return
    setBusy(true)
    setProblems([])
    // Tant que les photos se préparent, le formulaire ne part pas : le
    // navigateur le dit sur ce champ.
    carrier.setCustomValidity('Les photos sont en cours de préparation. Patientez un instant.')
    const failures: string[] = []
    let next = [...pagesRef.current]

    for (const [index, file] of files.entries()) {
      if (isPdf(file)) {
        if (files.length > 1) failures.push(`${file.name} : un PDF se joint seul, sans autre fichier.`)
        else if (file.size > MAX_SCAN_BYTES) failures.push(`${file.name} : le fichier dépasse ${MAX_SCAN_BYTES / 1024 / 1024} Mo.`)
        // Le PDF tient lieu de toutes les pages.
        else next = [{ key: ++keyRef.current, file, preview: null }]
        continue
      }
      const kept = multiple ? next.filter((page) => page.preview !== null) : []
      if (kept.length >= MAX_SCAN_PHOTOS) {
        failures.push(`${file.name} : au plus ${MAX_SCAN_PHOTOS} photos. Au-delà, numérisez le courrier en PDF.`)
        continue
      }
      setStatus(`Préparation de la photo${files.length > 1 ? ` ${index + 1} sur ${files.length}` : ''}…`)
      try {
        const { blob } = await compressPhoto(file, { maxEdge: MAIL_PHOTO_MAX_EDGE, quality: MAIL_PHOTO_QUALITY })
        const weight = kept.reduce((total, page) => total + page.file.size, blob.size)
        if (weight > MAX_SCAN_PHOTOS_BYTES) {
          failures.push(
            `${file.name} : les photos dépasseraient ${MAX_SCAN_PHOTOS_BYTES / 1024 / 1024} Mo à elles toutes. Numérisez le courrier en PDF.`,
          )
          continue
        }
        const photo = new File([blob], multiple ? `page-${kept.length + 1}.jpg` : 'photo.jpg', { type: 'image/jpeg' })
        // Une photo remplace un PDF déjà choisi, et, sans plusieurs pages, la photo précédente.
        next = [...kept, { key: ++keyRef.current, file: photo, preview: URL.createObjectURL(blob) }]
      } catch (caught) {
        failures.push(
          `${file.name} : ${caught instanceof PhotoDecodeError ? caught.message : 'cette photo n’a pas pu être préparée. Reprenez-la.'}`,
        )
      }
    }

    apply(next)
    carrier.setCustomValidity('')
    setBusy(false)
    setProblems(failures)
    setStatus(summary(next))
  }

  function remove(key: number, position: number) {
    const next = pagesRef.current.filter((page) => page.key !== key)
    apply(next)
    setProblems([])
    setStatus(`${multiple ? `Page ${position} retirée.` : 'Photo retirée.'} ${summary(next)}`.trim())
    // Le bouton disparaît avec sa page : le focus revient au champ.
    carrierRef.current?.focus()
  }

  const describedBy = `${name}-hint${error ? ` ${name}-error` : ''}`

  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}{' '}
        {!required && <span className="font-normal text-muted-foreground">(facultatif)</span>}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {enhanced && (
          // Téléphone ou tablette : l'appareil photo s'ouvre directement,
          // une page après l'autre.
          <label className={cameraClass}>
            <CameraIcon size={20} />
            {busy
              ? 'Préparation…'
              : multiple && pages.some((page) => page.preview !== null)
                ? 'Photographier la page suivante'
                : 'Prendre une photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              aria-describedby={`${name}-hint`}
              className="sr-only"
              onChange={(event) => {
                const picked = [...(event.currentTarget.files ?? [])]
                // Vidé aussitôt : la même photo peut être reprise.
                event.currentTarget.value = ''
                void add(picked)
              }}
            />
          </label>
        )}
        <input
          ref={carrierRef}
          id={name}
          name={name}
          type="file"
          accept={SCAN_ACCEPT}
          multiple={multiple}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (!enhanced) return
            const picked = [...(event.currentTarget.files ?? [])]
            // Le navigateur remplace la sélection du champ ; une fenêtre
            // fermée sans choix la vide parfois. Les pages déjà ajoutées y
            // reviennent dans les deux cas.
            if (picked.length === 0) apply(pagesRef.current)
            else void add(picked)
          }}
          className="block min-w-0 flex-1 text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </div>

      {pages.length > 0 && (
        <ol aria-label={`${label} : ${multiple ? 'pages jointes' : 'fichier joint'}`} className="mt-3 flex flex-wrap gap-3">
          {pages.map((page, index) => {
            const caption = page.preview === null ? 'PDF' : multiple ? `Page ${index + 1}` : 'Photo'
            return (
              <li key={page.key} className="flex w-24 flex-col gap-1">
                {page.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- aperçu local du navigateur, avant tout envoi
                  <img
                    src={page.preview}
                    alt={`${label}, ${caption.toLowerCase()}`}
                    className="h-32 w-24 rounded-md border border-border bg-muted object-cover"
                  />
                ) : (
                  <span className="flex h-32 w-24 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted px-2 text-center text-xs text-muted-foreground">
                    <FileTextIcon size={20} />
                    <span className="line-clamp-3 break-all">{page.file.name}</span>
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{caption}</span>
                <button
                  type="button"
                  onClick={() => remove(page.key, index + 1)}
                  aria-label={`Retirer ${multiple && page.preview ? `la page ${index + 1}` : 'le fichier'} — ${label}`}
                  className="min-h-6 self-start text-xs font-medium text-destructive underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Retirer
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
        {hint}
      </p>
      <p aria-live="polite" className="mt-1 text-xs text-foreground empty:hidden">
        {status}
      </p>
      {problems.length > 0 && (
        <ul
          role="alert"
          className="mt-2 list-disc rounded-md border border-destructive/30 bg-destructive/5 py-2 pl-8 pr-4 text-xs text-destructive"
        >
          {/* Deux fichiers du même nom peuvent échouer de la même façon. */}
          {problems.map((problem, index) => (
            <li key={`${index}-${problem}`}>{problem}</li>
          ))}
        </ul>
      )}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
