'use client'

import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { SenderDatalist } from './expediteur-form.tsx'
import { MAX_SENDER_LENGTH, senderListId, suggestionsFor, type SenderSuggestions } from './expediteurs.ts'
import { CameraIcon, mailKindIcons } from './icones.tsx'
import { mailKindLabels } from './labels.ts'
import { preparePhoto, type PhotoPage } from './photos-field.tsx'
import type { MailRecipient } from './saisie-groupee.ts'
import { registerMailEntryAction, type MailEntryFormState } from './saisie-groupee-actions.ts'
import {
  DEFAULT_ENTRY_KIND,
  entryCards,
  entryFieldName,
  MAX_ENTRY_PHOTOS_BYTES,
  MAX_PER_ENTRY,
} from './saisie-groupee-regles.ts'
import { mailKinds, type MailKind } from './schema.ts'

/** Un pli de la saisie, tant qu'il n'est pas enregistré. */
type Draft = {
  key: number
  clientId: string
  kind: MailKind
  sender: string
  /** Photo de l'enveloppe, déjà compressée ; nulle pour un pli sans photo. */
  photo: PhotoPage | null
}

/** Entreprises proposées à la fois : au-delà, la recherche se précise. */
const MAX_RESULTS = 6

const fieldClass =
  'rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
// Cibles de 44 px : l'écran sert au téléphone et à la tablette, pendant le tri.
const actionBase =
  'relative inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring disabled:cursor-not-allowed disabled:opacity-50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50'
const actionClass = `${actionBase} border-border bg-white text-foreground hover:bg-muted`
// Couleurs à part, jamais ajoutées par-dessus celles d'`actionClass` : avec
// deux `bg-*` sur un même élément, c'est l'ordre de la feuille de style qui
// gagne, et le bouton sortait blanc sur blanc (recette du 17/11). Blanc sur
// `--primary` : contraste ≈ 9,7:1.
const cameraClass = `${actionBase} border-primary bg-primary text-primary-foreground hover:bg-primary-hover`
// Type d'un pli : quatre puces, une touche pour corriger.
const kindClass =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-xs font-medium hover:bg-muted has-[:checked]:border-primary has-[:checked]:bg-accent/10 has-[:checked]:text-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring sm:min-h-9'

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count > 1 ? many : word}`

/**
 * Saisie groupée du courrier (ADR 058, simplifiée par l'ADR 079) : **un seul
 * écran**, sans étape. On cherche l'entreprise ; sur téléphone ou tablette,
 * « Ajouter un courrier » sur sa ligne la choisit et ouvre l'appareil d'un même
 * geste. **Une photo = un pli**, en lettre par défaut : le type et
 * l'expéditeur se corrigent pli par pli, sur sa carte, si besoin. Puis
 * l'entreprise suivante, et « Enregistrer » une fois pour tout.
 *
 * Les photos sont compressées dans le navigateur (`preparePhoto`, ADR 055)
 * et gardées ici jusqu'à l'envoi : un envoi refusé ne perd rien. Au clavier :
 * le nom ou le numéro de boîte, `Entrée` choisit la première entreprise et
 * mène à ses boutons de photo, `Ctrl`+`Entrée` enregistre tout.
 */
export function MailEntryForm({
  recipients,
  suggestions,
  defaultReceivedAt,
}: {
  recipients: MailRecipient[]
  suggestions: SenderSuggestions
  /** Heure murale du centre, au format `datetime-local`. */
  defaultReceivedAt: string
}) {
  const [state, formAction, pending] = useActionState<MailEntryFormState, FormData>(registerMailEntryAction, null)
  const [receivedAt, setReceivedAt] = useState(defaultReceivedAt)
  const [query, setQuery] = useState('')
  const [clientId, setClientId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [preparing, setPreparing] = useState(0)
  const [status, setStatus] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const lastKey = useRef(0)
  const draftsRef = useRef(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  // Les aperçus locaux se libèrent quand l'écran se démonte (enregistrement fait).
  useEffect(
    () => () => {
      for (const draft of draftsRef.current) if (draft.photo?.preview) URL.revokeObjectURL(draft.photo.preview)
    },
    [],
  )

  const names = useMemo(() => new Map(recipients.map((r) => [r.id, r.name])), [recipients])
  const nameOf = (id: string) => names.get(id) ?? 'Entreprise archivée'

  const matches = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    return recipients.filter((r) => {
      const haystack = fold(`${r.name} ${r.mailbox ?? ''}`)
      return terms.every((term) => haystack.includes(term))
    })
  }, [query, recipients])
  const shown = matches.slice(0, MAX_RESULTS)

  const cards = entryCards(drafts, clientId)
  const total = drafts.length
  const photoCount = drafts.filter((draft) => draft.photo).length
  const photoBytes = drafts.reduce((sum, draft) => sum + (draft.photo?.file.size ?? 0), 0)
  const tooHeavy = photoBytes > MAX_ENTRY_PHOTOS_BYTES
  const tooMany = total > MAX_PER_ENTRY
  const blocked = pending || preparing > 0 || total === 0 || tooHeavy || tooMany
  const errors = state?.fieldErrors ?? {}

  const nextKey = () => (lastKey.current += 1)
  const focusCard = (id: string) =>
    requestAnimationFrame(() => document.getElementById(`carte-${id}`)?.focus())

  /** Choisit l'entreprise : sa carte devient celle où vont les photos. */
  function choose(id: string, { focus = true } = {}) {
    setClientId(id)
    setQuery('')
    setStatus(`Entreprise choisie : ${nameOf(id)}. Chaque photo sera un pli pour elle.`)
    if (focus) focusCard(id)
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return
    // Entrée ne soumet pas : elle choisit la première entreprise.
    event.preventDefault()
    const first = matches[0]
    if (first) choose(first.id)
  }

  async function addPhotos(target: string, files: File[]) {
    if (files.length === 0) return
    setFailures([])
    setPreparing(files.length)
    const refused: string[] = []
    let added = 0
    for (const [index, file] of files.entries()) {
      setStatus(`Préparation de la photo${files.length > 1 ? ` ${index + 1} sur ${files.length}` : ''}…`)
      const key = nextKey()
      const result = await preparePhoto(file, `enveloppe-${key}.jpg`)
      setPreparing(files.length - index - 1)
      if (result.page) {
        const draft: Draft = { key, clientId: target, kind: DEFAULT_ENTRY_KIND, sender: '', photo: result.page }
        added += 1
        // Chaque pli paraît sur la carte dès que sa photo est prête.
        setDrafts((current) => [...current, draft])
      } else {
        refused.push(result.failure)
      }
    }
    setFailures(refused)
    setStatus(
      added === 0
        ? 'Aucune photo n’a pu être préparée.'
        : `${nameOf(target)} : ${plural(added, 'pli ajouté', 'plis ajoutés')}, en lettre. Corrigez le type sur la carte si besoin.`,
    )
  }

  function addWithoutPhoto(target: string) {
    setDrafts((current) => [...current, { key: nextKey(), clientId: target, kind: DEFAULT_ENTRY_KIND, sender: '', photo: null }])
    setStatus(`${nameOf(target)} : un pli sans photo ajouté, en lettre.`)
  }

  /** Retire des plis : un seul, ou tous ceux d'une entreprise. */
  function remove(removed: Draft[], message: string, focusOn: string) {
    const keys = new Set(removed.map((draft) => draft.key))
    for (const draft of removed) if (draft.photo?.preview) URL.revokeObjectURL(draft.photo.preview)
    setDrafts((current) => current.filter((other) => !keys.has(other.key)))
    setStatus(message)
    // Le bouton disparaît avec son pli : le focus revient à la carte, ou à la recherche.
    requestAnimationFrame(() => (document.getElementById(focusOn) ?? searchRef.current)?.focus())
  }

  const update = (key: number, change: Partial<Pick<Draft, 'kind' | 'sender'>>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)))

  function onDrop(event: DragEvent<HTMLElement>, target: string) {
    event.preventDefault()
    setDragging(false)
    if (preparing > 0) return
    setClientId(target)
    void addPhotos(target, [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/')))
  }

  function submit() {
    if (blocked) return
    // Dans l'ordre des cartes : c'est celui de l'enregistrement, donc du rang
    // de chaque pli dans sa journée (ADR 057).
    const data = new FormData()
    data.set('receivedAt', receivedAt)
    for (const draft of cards.flatMap((card) => card.items)) {
      data.append(entryFieldName(draft.key, 'client'), draft.clientId)
      data.append(entryFieldName(draft.key, 'kind'), draft.kind)
      data.append(entryFieldName(draft.key, 'sender'), draft.sender)
      if (draft.photo) data.append(entryFieldName(draft.key, 'photo'), draft.photo.file)
    }
    startTransition(() => formAction(data))
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  }

  // Libellés du résumé d'erreurs : chaque pli par son entreprise et son rang.
  const labels: Record<string, string> = { receivedAt: 'Reçu le' }
  for (const card of cards) {
    card.items.forEach((draft, index) => {
      const subject = `${nameOf(card.clientId)} — pli ${index + 1}`
      labels[entryFieldName(draft.key, 'sender')] = `${subject}, expéditeur`
      labels[entryFieldName(draft.key, 'photo')] = `${subject}, photo`
      labels[entryFieldName(draft.key, 'client')] = subject
      labels[entryFieldName(draft.key, 'kind')] = `${subject}, type`
    })
  }

  const submitLabel = pending
    ? 'Enregistrement…'
    : preparing > 0
      ? 'Préparation des photos…'
      : total <= 1
        ? 'Enregistrer le pli'
        : `Enregistrer les ${total} plis`

  /** Boutons de photo : l'appareil (téléphone, tablette), des fichiers, ou un pli sans photo. */
  const photoButtons = (target: string, compact = false) => {
    const name = nameOf(target)
    const pick = (capture: boolean) => (
      <input
        type="file"
        accept="image/*"
        multiple={!capture}
        capture={capture ? 'environment' : undefined}
        disabled={preparing > 0}
        className="sr-only"
        onClick={() => setClientId(target)}
        onChange={(event) => {
          const picked = [...(event.currentTarget.files ?? [])]
          // Vidé aussitôt : la même photo peut être reprise.
          event.currentTarget.value = ''
          setClientId(target)
          setQuery('')
          void addPhotos(target, picked)
        }}
      />
    )
    return (
      <div className="flex flex-wrap gap-2">
        {/* Téléphone ou tablette : l'appareil photo s'ouvre directement, un pli après l'autre. */}
        <label className={`${cameraClass} hidden pointer-coarse:inline-flex`}>
          <CameraIcon size={20} />
          Ajouter un courrier
          <span className="sr-only"> pour {name}</span>
          {pick(true)}
        </label>
        {!compact && (
          <>
            <label className={actionClass}>
              {preparing > 0 ? 'Préparation…' : 'Choisir des photos'}
              <span className="sr-only"> pour {name}</span>
              {pick(false)}
            </label>
            <button
              type="button"
              onClick={() => addWithoutPhoto(target)}
              // Pendant la préparation, un pli sans photo s'intercalerait entre les photos.
              disabled={preparing > 0}
              className={actionClass}
            >
              + Pli sans photo<span className="sr-only"> pour {name}</span>
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    // Pas de bouton d'envoi : `Entrée` dans un champ (un expéditeur choisi dans
    // la liste, l'heure) n'enregistre jamais toute la saisie par mégarde. On
    // enregistre par le bouton, ou par `Ctrl`+`Entrée`.
    <form onSubmit={(event) => event.preventDefault()} onKeyDown={onFormKeyDown} className="flex max-w-3xl flex-col gap-5">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />
      <p className="text-xs text-muted-foreground">Les champs marqués * sont obligatoires.</p>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div>
          <label htmlFor="receivedAt" className="block text-sm font-medium text-foreground">
            Reçu le<span aria-hidden="true"> *</span>
          </label>
          <input
            id="receivedAt"
            type="datetime-local"
            required
            aria-required
            value={receivedAt}
            onChange={(event) => setReceivedAt(event.target.value)}
            aria-invalid={errors.receivedAt ? true : undefined}
            aria-describedby={`receivedAt-aide${errors.receivedAt ? ' receivedAt-error' : ''}`}
            className={`${fieldClass} mt-1 tabular`}
          />
        </div>
        <p id="receivedAt-aide" className="pb-2 text-xs text-muted-foreground">
          Pour tous les plis de cet envoi.
        </p>
        {errors.receivedAt && (
          <p id="receivedAt-error" className="w-full text-xs text-destructive">
            {errors.receivedAt}
          </p>
        )}
      </div>

      {/* L'entreprise : chercher, puis photographier depuis sa ligne. */}
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor="recherche" className="text-sm font-medium text-foreground">
          Entreprise : nom ou numéro de boîte
        </label>
        <input
          ref={searchRef}
          id="recherche"
          type="search"
          autoFocus
          autoComplete="off"
          enterKeyHint="go"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-describedby="recherche-aide"
          aria-controls="entreprises"
          className={`${fieldClass} w-full`}
        />
        <p id="recherche-aide" className="text-xs text-muted-foreground">
          <kbd>Entrée</kbd> choisit la première entreprise. Les domiciliés d’abord.
        </p>
        <ul id="entreprises" aria-label="Entreprises trouvées" className="flex flex-col gap-2">
          {shown.map((recipient) => (
            <li
              key={recipient.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-white px-3 py-1.5"
            >
              <button
                type="button"
                onClick={() => choose(recipient.id)}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{recipient.name}</span>
                {recipient.mailbox && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular">{recipient.mailbox}</span>
                )}
                {recipient.domiciled && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Domicilié</span>
                )}
              </button>
              {/* Un geste : l'entreprise est choisie et l'appareil s'ouvre. */}
              {photoButtons(recipient.id, true)}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {query.trim() === ''
            ? ''
            : matches.length === 0
              ? `Aucune entreprise ne correspond à « ${query} ». Vérifiez l’orthographe, ou cherchez par numéro de boîte.`
              : matches.length > MAX_RESULTS
                ? `${plural(matches.length - MAX_RESULTS, 'autre entreprise')} : précisez la recherche.`
                : ''}
        </p>
      </div>

      <p aria-live="polite" className="min-h-5 text-sm text-foreground">
        {status}
      </p>
      {failures.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
          {failures.map((failure, index) => (
            <li key={`${index}-${failure}`}>{failure}</li>
          ))}
        </ul>
      )}

      {/* Les plis, entreprise par entreprise, dans l'ordre de la saisie. */}
      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-sm text-muted-foreground">
          Aucun pli pour l’instant. Cherchez une entreprise, puis photographiez ses enveloppes : chaque photo devient
          un pli, en lettre par défaut.
        </p>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Plis saisis">
          {cards.map((card) => {
            const name = nameOf(card.clientId)
            const listId = senderListId(card.clientId)
            const active = card.clientId === clientId
            return (
              <li key={card.clientId}>
                <section
                  id={`carte-${card.clientId}`}
                  tabIndex={-1}
                  aria-label={`${name} : ${card.phrase || 'aucun pli'}`}
                  className={`flex flex-col rounded-lg border bg-white transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    active ? (dragging ? 'border-accent bg-accent/5' : 'border-primary') : 'border-border'
                  }`}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => onDrop(event, card.clientId)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2">
                    <h2 className="min-w-0 text-sm font-semibold">
                      <span className="break-words">{name}</span>
                      {card.phrase && <span className="font-normal tabular"> : {card.phrase}</span>}
                    </h2>
                    {card.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          remove(card.items, `Les ${card.items.length} plis de ${name} sont retirés.`, 'recherche')
                        }
                        className="min-h-11 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-8"
                      >
                        Retirer les {card.items.length} plis<span className="sr-only"> de {name}</span>
                      </button>
                    )}
                  </div>
                  <SenderDatalist id={listId} senders={suggestionsFor(suggestions, card.clientId)} />
                  {card.items.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">
                      Photographiez ou déposez les enveloppes : une photo, un pli.
                    </p>
                  ) : (
                    <ol className="divide-y divide-border">
                      {card.items.map((draft, index) => {
                        const subject = `pli ${index + 1} de ${name}`
                        const senderField = entryFieldName(draft.key, 'sender')
                        const photoField = entryFieldName(draft.key, 'photo')
                        const kindField = entryFieldName(draft.key, 'kind')
                        const itemErrors = [errors[photoField], errors[entryFieldName(draft.key, 'client')], errors[kindField]].filter(Boolean)
                        return (
                          // Cible des liens du résumé d'erreurs pour la photo d'un pli : focalisable, focus visible.
                          <li
                            key={draft.key}
                            id={photoField}
                            tabIndex={-1}
                            className="flex gap-3 px-4 py-3 focus:outline-2 focus:-outline-offset-2 focus:outline-ring"
                          >
                            {draft.photo?.preview ? (
                              // eslint-disable-next-line @next/next/no-img-element -- aperçu local du navigateur, avant tout envoi
                              <img
                                src={draft.photo.preview}
                                alt={`Enveloppe du ${subject}`}
                                className="h-20 w-14 shrink-0 rounded-sm border border-border bg-muted object-cover"
                              />
                            ) : (
                              <span className="flex h-20 w-14 shrink-0 items-center justify-center rounded-sm bg-muted px-1 text-center text-[11px] leading-tight text-muted-foreground">
                                Sans photo
                              </span>
                            )}
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-medium">Pli {index + 1}</p>
                                <button
                                  type="button"
                                  onClick={() => remove([draft], `Le ${subject} est retiré.`, `carte-${card.clientId}`)}
                                  aria-label={`Retirer le ${subject}`}
                                  className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-8"
                                >
                                  Retirer
                                </button>
                              </div>
                              <fieldset id={kindField} className="flex min-w-0 flex-col gap-1">
                                <legend className="text-xs font-medium text-foreground">Type</legend>
                                <div className="flex flex-wrap gap-1.5">
                                  {mailKinds.map((option) => {
                                    const Icon = mailKindIcons[option]
                                    return (
                                      <label key={option} className={kindClass}>
                                        <input
                                          type="radio"
                                          name={`type-${draft.key}`}
                                          value={option}
                                          checked={draft.kind === option}
                                          onChange={() => update(draft.key, { kind: option })}
                                          className="sr-only"
                                        />
                                        <Icon size={16} className="shrink-0" />
                                        {mailKindLabels[option]}
                                      </label>
                                    )
                                  })}
                                </div>
                              </fieldset>
                              <div className="flex min-w-0 flex-col gap-1">
                                <label htmlFor={senderField} className="text-xs font-medium text-foreground">
                                  Expéditeur <span className="font-normal text-muted-foreground">(facultatif)</span>
                                </label>
                                <input
                                  id={senderField}
                                  list={listId}
                                  value={draft.sender}
                                  onChange={(event) => update(draft.key, { sender: event.target.value })}
                                  autoComplete="off"
                                  maxLength={MAX_SENDER_LENGTH}
                                  aria-invalid={errors[senderField] ? true : undefined}
                                  aria-describedby={errors[senderField] ? `${senderField}-error` : undefined}
                                  className={`${fieldClass} w-full`}
                                />
                                {errors[senderField] && (
                                  <p id={`${senderField}-error`} className="text-xs text-destructive">
                                    {errors[senderField]}
                                  </p>
                                )}
                              </div>
                              {itemErrors.map((error) => (
                                <p key={error} className="text-xs text-destructive">
                                  {error}
                                </p>
                              ))}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
                    {active ? (
                      photoButtons(card.clientId)
                    ) : (
                      <button
                        type="button"
                        onClick={() => choose(card.clientId)}
                        className={`${actionClass} self-start`}
                      >
                        Ajouter des plis<span className="sr-only"> pour {name}</span>
                      </button>
                    )}
                  </div>
                </section>
              </li>
            )
          })}
        </ul>
      )}

      {/* Toujours à portée, au pouce comme au clavier. */}
      <div className="sticky bottom-0 z-20 -mx-1 flex flex-col gap-2 rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
        {(tooHeavy || tooMany) && (
          <p className="text-sm text-destructive" role="alert">
            {tooMany
              ? `${total} plis en une fois : au-delà de ${MAX_PER_ENTRY}, enregistrez la tournée en deux envois.`
              : `Les photos pèsent ${(photoBytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo : au-delà de ${MAX_ENTRY_PHOTOS_BYTES / 1024 / 1024} Mo, enregistrez la tournée en deux envois.`}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm tabular">
            {total === 0
              ? 'Aucun pli saisi.'
              : `${plural(total, 'pli', 'plis')} pour ${plural(cards.filter((card) => card.items.length > 0).length, 'entreprise')}, ${
                  total === 1
                    ? photoCount === 1
                      ? 'avec photo'
                      : 'sans photo'
                    : photoCount === total
                      ? 'tous avec photo'
                      : photoCount === 0
                        ? 'aucun avec photo'
                        : `dont ${photoCount} avec photo`
                }.`}
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={blocked}
            className="min-h-11 rounded-md bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  )
}
