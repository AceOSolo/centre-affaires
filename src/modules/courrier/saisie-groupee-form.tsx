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
import { entryFieldName, groupEntry, MAX_ENTRY_PHOTOS_BYTES, MAX_PER_ENTRY } from './saisie-groupee-regles.ts'
import { mailKinds, type MailKind } from './schema.ts'
import { mailKindsPhrase } from './tournees-regles.ts'

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
const choiceClass =
  'flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted has-[:checked]:border-primary has-[:checked]:bg-accent/10 has-[:checked]:font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring'
const actionClass =
  'relative inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring disabled:cursor-not-allowed disabled:opacity-50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50'

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count > 1 ? many : word}`

/** « 2 lettres », « 1 colis » : un seul type. */
const kindPhrase = (kind: MailKind, count: number) =>
  mailKindsPhrase({ ...(Object.fromEntries(mailKinds.map((k) => [k, 0])) as Record<MailKind, number>), [kind]: count })

/**
 * Saisie groupée du courrier (ADR 058) : **une photo = un pli**, sans double
 * saisie. Entreprise, type, puis les photos des enveloppes — chacune crée un
 * pli de ce type pour cette entreprise —, et ainsi de suite pour la suivante.
 * Le récapitulatif dit « ACME : 3 lettres et 1 colis », permet de retirer un
 * pli et de préciser son expéditeur ; tout part en un seul envoi.
 *
 * Les photos sont compressées dans le navigateur (`preparePhoto`, ADR 055)
 * et gardées ici jusqu'à l'envoi : un envoi refusé ne perd rien. Au clavier :
 * le nom ou le numéro de boîte, `Entrée` choisit la première entreprise et
 * passe au type, `Tab` mène aux photos, `Ctrl`+`Entrée` enregistre tout.
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
  const [kind, setKind] = useState<MailKind>('lettre')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [preparing, setPreparing] = useState(0)
  const [status, setStatus] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const recapRef = useRef<HTMLHeadingElement>(null)
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
  const selected = recipients.find((r) => r.id === clientId)

  const matches = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean)
    return recipients.filter((r) => {
      const haystack = fold(`${r.name} ${r.mailbox ?? ''}`)
      return terms.every((term) => haystack.includes(term))
    })
  }, [query, recipients])
  const shown = matches.slice(0, MAX_RESULTS)
  // L'entreprise choisie reste visible, même hors de la recherche en cours.
  const options = selected && !shown.some((r) => r.id === selected.id) ? [selected, ...shown] : shown

  const groups = groupEntry(drafts)
  const total = drafts.length
  const photoCount = drafts.filter((draft) => draft.photo).length
  const photoBytes = drafts.reduce((sum, draft) => sum + (draft.photo?.file.size ?? 0), 0)
  const tooHeavy = photoBytes > MAX_ENTRY_PHOTOS_BYTES
  const tooMany = total > MAX_PER_ENTRY
  const blocked = pending || preparing > 0 || total === 0 || tooHeavy || tooMany
  const errors = state?.fieldErrors ?? {}

  const nextKey = () => (lastKey.current += 1)

  function choose(id: string) {
    setClientId(id)
    setStatus(`Entreprise choisie : ${nameOf(id)}.`)
  }

  const focusKind = () => requestAnimationFrame(() => document.getElementById(`type-${kind}`)?.focus())

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return
    // Entrée ne soumet pas : elle choisit la première entreprise et passe au type.
    event.preventDefault()
    const first = matches[0]
    if (!first) return
    choose(first.id)
    setQuery('')
    focusKind()
  }

  function nextCompany() {
    setQuery('')
    searchRef.current?.focus()
  }

  async function addPhotos(files: File[]) {
    if (!clientId || files.length === 0) return
    // Pour l'entreprise et le type choisis à cet instant, même s'ils changent pendant la préparation.
    const target = { clientId, kind }
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
        const draft: Draft = { key, ...target, sender: '', photo: result.page }
        added += 1
        // Chaque pli paraît au récapitulatif dès que sa photo est prête.
        setDrafts((current) => [...current, draft])
      } else {
        refused.push(result.failure)
      }
    }
    setFailures(refused)
    setStatus(
      added === 0
        ? 'Aucune photo n’a pu être préparée.'
        : `Ajouté pour ${nameOf(target.clientId)} : ${kindPhrase(target.kind, added)}, une photo par pli.`,
    )
  }

  function addWithoutPhoto() {
    if (!clientId) return
    setDrafts((current) => [...current, { key: nextKey(), clientId, kind, sender: '', photo: null }])
    setStatus(`Ajouté pour ${nameOf(clientId)} : ${kindPhrase(kind, 1)}, sans photo.`)
  }

  /** Retire des plis du récapitulatif : un seul, ou tous ceux d'une entreprise. */
  function remove(removed: Draft[], message: string) {
    const keys = new Set(removed.map((draft) => draft.key))
    for (const draft of removed) if (draft.photo?.preview) URL.revokeObjectURL(draft.photo.preview)
    setDrafts((current) => current.filter((other) => !keys.has(other.key)))
    setStatus(message)
    // Le bouton disparaît avec son pli : le focus revient au récapitulatif.
    recapRef.current?.focus()
  }

  function changeSender(key: number, sender: string) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, sender } : draft)))
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (!clientId || preparing > 0) return
    void addPhotos([...event.dataTransfer.files].filter((file) => file.type.startsWith('image/')))
  }

  function submit() {
    if (blocked) return
    // Dans l'ordre du récapitulatif : c'est celui de l'enregistrement, donc du
    // rang de chaque pli dans sa journée (ADR 057).
    const data = new FormData()
    data.set('receivedAt', receivedAt)
    for (const draft of groups.flatMap((group) => group.items)) {
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
  for (const group of groups) {
    group.items.forEach((draft, index) => {
      const subject = `${nameOf(group.clientId)} — pli ${index + 1} (${mailKindLabels[draft.kind].toLowerCase()})`
      labels[entryFieldName(draft.key, 'sender')] = `${subject}, expéditeur`
      labels[entryFieldName(draft.key, 'photo')] = `${subject}, photo`
      labels[entryFieldName(draft.key, 'client')] = subject
      labels[entryFieldName(draft.key, 'kind')] = subject
    })
  }

  const submitLabel = pending
    ? 'Enregistrement…'
    : preparing > 0
      ? 'Préparation des photos…'
      : total <= 1
        ? 'Enregistrer le pli dans la tournée'
        : `Enregistrer les ${total} plis dans la tournée`

  return (
    // Pas de bouton d'envoi : `Entrée` dans un champ (un expéditeur choisi dans
    // la liste, l'heure) n'enregistre jamais toute la saisie par mégarde. On
    // enregistre par le bouton, ou par `Ctrl`+`Entrée`.
    <form onSubmit={(event) => event.preventDefault()} onKeyDown={onFormKeyDown} className="flex flex-col gap-6">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div>
          <label htmlFor="receivedAt" className="block text-sm font-medium text-foreground">
            Reçu le
          </label>
          <input
            id="receivedAt"
            type="datetime-local"
            required
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

      {/* `grid-cols-1` et `min-w-0` : un nom d'entreprise long ne fait pas défiler la page de côté. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {/* 1. Entreprise */}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-base font-semibold tracking-tight">1. Entreprise</legend>
            <label htmlFor="recherche" className="text-sm font-medium text-foreground">
              Rechercher : nom ou numéro de boîte
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
              <kbd>Entrée</kbd> choisit la première entreprise de la liste. Les domiciliés d’abord.
            </p>
            <div id="entreprises" role="radiogroup" aria-label="Entreprise du pli" className="flex flex-col gap-2">
              {options.map((recipient) => (
                <label key={recipient.id} className={choiceClass}>
                  <input
                    type="radio"
                    name="entreprise"
                    value={recipient.id}
                    checked={recipient.id === clientId}
                    onChange={() => choose(recipient.id)}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate">{recipient.name}</span>
                  {recipient.mailbox && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{recipient.mailbox}</span>
                  )}
                  {recipient.domiciled && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Domicilié
                    </span>
                  )}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {matches.length === 0
                ? `Aucune entreprise ne correspond à « ${query} ». Vérifiez l’orthographe, ou cherchez par numéro de boîte.`
                : matches.length > MAX_RESULTS
                  ? `${plural(matches.length - MAX_RESULTS, 'autre entreprise')} : précisez la recherche.`
                  : ''}
            </p>
          </fieldset>

          {/* 2. Type */}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-base font-semibold tracking-tight">2. Type de pli</legend>
            {/* Quatre de front sur tablette ; deux sur deux dans la colonne de l'ordinateur. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              {mailKinds.map((option) => {
                const Icon = mailKindIcons[option]
                return (
                  <label key={option} className={choiceClass}>
                    <input
                      id={`type-${option}`}
                      type="radio"
                      name="type"
                      value={option}
                      checked={kind === option}
                      onChange={() => setKind(option)}
                      className="sr-only"
                    />
                    <Icon size={20} className="shrink-0 text-primary" />
                    {mailKindLabels[option]}
                  </label>
                )
              })}
            </div>
          </fieldset>

          {/* 3. Photos */}
          <fieldset
            className={`flex min-w-0 flex-col gap-3 rounded-lg border border-dashed px-4 py-3 transition-colors duration-150 ease-out ${dragging ? 'border-accent bg-accent/5' : 'border-border'}`}
            onDragOver={(event) => {
              if (!clientId) return
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <legend className="px-1 text-base font-semibold tracking-tight">3. Photos des enveloppes</legend>
            <p id="photos-aide" className="text-sm text-muted-foreground">
              {selected ? (
                <>
                  Pour <span className="font-medium text-foreground">{selected.name}</span>,{' '}
                  {mailKindLabels[kind].toLowerCase()} : <strong className="font-medium text-foreground">chaque photo est un pli</strong>.
                  Plusieurs photos d’un coup, ou déposez-les ici.
                </>
              ) : (
                'Choisissez d’abord l’entreprise (étape 1) : chaque photo sera un pli pour elle.'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {/* Téléphone ou tablette : l'appareil photo s'ouvre directement, un pli après l'autre. */}
              <label className={`${actionClass} hidden pointer-coarse:inline-flex`}>
                <CameraIcon size={20} />
                {drafts.some((draft) => draft.clientId === clientId && draft.kind === kind && draft.photo)
                  ? 'Photographier le pli suivant'
                  : 'Prendre une photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  disabled={!clientId || preparing > 0}
                  aria-describedby="photos-aide"
                  className="sr-only"
                  onChange={(event) => {
                    const picked = [...(event.currentTarget.files ?? [])]
                    // Vidé aussitôt : la même photo peut être reprise.
                    event.currentTarget.value = ''
                    void addPhotos(picked)
                  }}
                />
              </label>
              <label className={actionClass}>
                {preparing > 0 ? 'Préparation…' : 'Choisir des photos'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={!clientId || preparing > 0}
                  aria-describedby="photos-aide"
                  className="sr-only"
                  onChange={(event) => {
                    const picked = [...(event.currentTarget.files ?? [])]
                    event.currentTarget.value = ''
                    void addPhotos(picked)
                  }}
                />
              </label>
              <button
                type="button"
                onClick={addWithoutPhoto}
                // Pendant la préparation, un pli sans photo s'intercalerait entre les photos.
                disabled={!clientId || preparing > 0}
                aria-describedby="sans-photo-aide"
                className={actionClass}
              >
                + Pli sans photo
              </button>
            </div>
            <p id="sans-photo-aide" className="text-xs text-muted-foreground">
              Sans photo : appareil absent, enveloppe abîmée. La photo s’ajoute ensuite depuis la tournée.
            </p>
            {failures.length > 0 && (
              <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
                {failures.map((failure, index) => (
                  <li key={`${index}-${failure}`}>{failure}</li>
                ))}
              </ul>
            )}
            {selected && (
              <button
                type="button"
                onClick={nextCompany}
                className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-h-11"
              >
                Entreprise suivante
              </button>
            )}
          </fieldset>
          <p aria-live="polite" className="-mt-3 min-h-5 text-sm text-foreground">
            {status}
          </p>
        </div>

        {/* 4. Récapitulatif */}
        <section aria-labelledby="recapitulatif" className="flex min-w-0 flex-col gap-3">
          <h2
            id="recapitulatif"
            ref={recapRef}
            tabIndex={-1}
            className="text-base font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            4. Récapitulatif
          </h2>
          {groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-sm text-muted-foreground">
              Aucun pli pour l’instant. Choisissez une entreprise et un type, puis prenez ou déposez les photos
              des enveloppes : chaque photo devient un pli.
            </p>
          ) : (
            groups.map((group) => {
              const name = nameOf(group.clientId)
              const listId = senderListId(group.clientId)
              return (
                <div key={group.clientId} className="rounded-lg border border-border bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 border-b border-border px-4 py-1">
                    <h3 className="py-1 text-sm font-semibold">
                      {name} : <span className="font-normal tabular">{group.phrase}</span>
                    </h3>
                    {group.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          remove(group.items, `Les ${group.items.length} plis de ${name} sont retirés du récapitulatif.`)
                        }
                        className="min-h-11 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        Retirer les {group.items.length} plis
                        <span className="sr-only"> de {name}</span>
                      </button>
                    )}
                  </div>
                  <SenderDatalist id={listId} senders={suggestionsFor(suggestions, group.clientId)} />
                  <ul className="divide-y divide-border">
                    {group.items.map((draft, index) => {
                      const subject = `pli ${index + 1} (${mailKindLabels[draft.kind].toLowerCase()}) — ${name}`
                      const senderField = entryFieldName(draft.key, 'sender')
                      const photoField = entryFieldName(draft.key, 'photo')
                      const itemErrors = [
                        errors[photoField],
                        errors[entryFieldName(draft.key, 'client')],
                        errors[entryFieldName(draft.key, 'kind')],
                      ].filter(Boolean)
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
                              className="h-16 w-12 shrink-0 rounded-sm border border-border bg-muted object-cover"
                            />
                          ) : (
                            <span className="flex h-16 w-12 shrink-0 items-center justify-center rounded-sm bg-muted px-1 text-center text-[11px] leading-tight text-muted-foreground">
                              Sans photo
                            </span>
                          )}
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium">
                                Pli {index + 1} · {mailKindLabels[draft.kind]}
                              </p>
                              <button
                                type="button"
                                onClick={() => remove([draft], `Le ${subject} est retiré du récapitulatif.`)}
                                aria-label={`Retirer le ${subject}`}
                                className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                Retirer
                              </button>
                            </div>
                            <label htmlFor={senderField} className="text-xs font-medium text-foreground">
                              Expéditeur <span className="font-normal text-muted-foreground">(facultatif)</span>
                            </label>
                            <input
                              id={senderField}
                              list={listId}
                              value={draft.sender}
                              onChange={(event) => changeSender(draft.key, event.target.value)}
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
                            {itemErrors.map((error) => (
                              <p key={error} className="text-xs text-destructive">
                                {error}
                              </p>
                            ))}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })
          )}
        </section>
      </div>

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
              : `${plural(total, 'pli', 'plis')} pour ${plural(groups.length, 'entreprise')}, ${
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
