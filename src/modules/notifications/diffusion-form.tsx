'use client'

import { useActionState, useEffect, useMemo, useRef, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { MailIcon, TriangleAlertIcon, UsersIcon } from '../../components/ui/icons.tsx'
import { broadcastAction, type BroadcastFormState } from './diffusion-actions.ts'
import type { BroadcastCandidate } from './diffusion.ts'
import {
  audiencePhrase,
  BROADCAST_BODY_MAX,
  BROADCAST_SELECTION_MAX,
  BROADCAST_SUBJECT_MAX,
  broadcastTargetDescriptions,
  broadcastTargetLabels,
  broadcastTargets,
  type BroadcastTarget,
} from './diffusion-regles.ts'

const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const secondaryButton =
  'inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-primary transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50'
const primaryButton =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover disabled:opacity-50'

const labels = {
  target: 'Destinataires',
  clients: 'Entreprises',
  subject: 'Objet',
  body: 'Texte du message',
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )
}

/**
 * Message libre aux clients (ADR 060) : destinataires, objet, texte, puis
 * l'aperçu avec le nombre d'entreprises et de personnes, puis la
 * confirmation. Toute modification après l'aperçu le périme : on ne confirme
 * que ce que l'on a relu.
 */
export function BroadcastForm({ candidates }: { candidates: BroadcastCandidate[] }) {
  const [state, formAction, pending] = useActionState<BroadcastFormState, FormData>(broadcastAction, null)
  const [target, setTarget] = useState<BroadcastTarget>(state?.values?.target ?? 'domiciliation')
  const [selected, setSelected] = useState<Set<string>>(new Set(state?.values?.clientIds ?? []))
  const [subject, setSubject] = useState(state?.values?.subject ?? '')
  const [body, setBody] = useState(state?.values?.body ?? '')
  const [filter, setFilter] = useState('')
  // L'aperçu affiché est celui de cet état ; une modification le périme.
  const [staleFor, setStaleFor] = useState<BroadcastFormState>(null)
  const previewRef = useRef<HTMLHeadingElement>(null)
  const errors = state?.fieldErrors ?? {}
  const preview = state?.preview
  const confirmable = Boolean(preview) && staleFor !== state

  useEffect(() => {
    // Le focus suit l'aperçu : au clavier comme au lecteur d'écran, on le lit aussitôt.
    if (state?.preview) previewRef.current?.focus()
  }, [state])

  const touch = () => {
    if (preview) setStaleFor(state)
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase('fr')
    return needle ? candidates.filter((candidate) => candidate.name.toLocaleLowerCase('fr').includes(needle)) : candidates
  }, [candidates, filter])

  const toggle = (id: string, checked: boolean) => {
    touch()
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleVisible = (checked: boolean) => {
    touch()
    setSelected((current) => {
      const next = new Set(current)
      for (const candidate of visible) {
        if (checked) next.add(candidate.id)
        else next.delete(candidate.id)
      }
      return next
    })
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <fieldset
        aria-describedby={errors.target ? 'target-error' : undefined}
        className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
      >
        <legend className="px-1 text-base font-semibold tracking-tight">Destinataires</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {broadcastTargets.map((value, index) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors duration-150 ease-out ${
                target === value ? 'border-accent bg-accent/5' : 'border-border hover:bg-muted'
              }`}
            >
              <input
                id={index === 0 ? 'target' : undefined}
                type="radio"
                name="target"
                value={value}
                checked={target === value}
                onChange={() => {
                  touch()
                  setTarget(value)
                }}
                aria-describedby={`target-${value}-hint`}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium">{broadcastTargetLabels[value]}</span>
                <span id={`target-${value}-hint`} className="block text-xs text-muted-foreground">
                  {broadcastTargetDescriptions[value]}
                </span>
              </span>
            </label>
          ))}
        </div>
        <FieldError id="target-error" error={errors.target} />

        {target === 'selection' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <label htmlFor="clients" className="block text-sm font-medium">
                  Chercher une entreprise
                </label>
                <input
                  id="clients"
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  autoComplete="off"
                  aria-describedby={`clients-count${errors.clients ? ' clients-error' : ''}`}
                  aria-invalid={errors.clients ? true : undefined}
                  className={fieldClass}
                />
              </div>
              <button type="button" onClick={() => toggleVisible(true)} className={secondaryButton}>
                Cocher {filter.trim() ? 'celles affichées' : 'toutes'}
              </button>
              <button type="button" onClick={() => toggleVisible(false)} className={secondaryButton}>
                Décocher {filter.trim() ? 'celles affichées' : 'toutes'}
              </button>
            </div>
            <p id="clients-count" aria-live="polite" className="text-sm text-muted-foreground">
              {selected.size} entreprise{selected.size > 1 ? 's' : ''} cochée{selected.size > 1 ? 's' : ''} sur{' '}
              {candidates.length} ({BROADCAST_SELECTION_MAX} au plus).
            </p>
            <FieldError id="clients-error" error={errors.clients} />
            {candidates.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Aucune fiche client pour l’instant : créez d’abord vos clients.
              </p>
            ) : (
              <div className="max-h-96 overflow-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Entreprises à cocher, les domiciliés d’abord</caption>
                  <thead className="sticky top-0 border-b border-border bg-white text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="w-12 px-3 py-2 font-medium">
                        <span className="sr-only">Cocher</span>
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">Entreprise</th>
                      <th scope="col" className="px-3 py-2 font-medium">Contrat en cours</th>
                      <th scope="col" className="px-3 py-2 font-medium">Espace client</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((candidate) => {
                      const id = `client-${candidate.id}`
                      return (
                        <tr key={candidate.id}>
                          <td className="px-3 py-2">
                            <input
                              id={id}
                              type="checkbox"
                              name="clients"
                              value={candidate.id}
                              checked={selected.has(candidate.id)}
                              onChange={(event) => toggle(candidate.id, event.target.checked)}
                              className="size-4 accent-primary"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <label htmlFor={id} className="cursor-pointer font-medium">
                              {candidate.name}
                            </label>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {[candidate.domiciled && 'Domiciliation', candidate.offices && 'Bureau']
                              .filter(Boolean)
                              .join(', ') || '—'}
                          </td>
                          <td className="px-3 py-2 tabular text-muted-foreground">
                            {candidate.people === 0
                              ? 'Aucun accès : rien ne lui parviendra'
                              : `${candidate.people} personne${candidate.people > 1 ? 's' : ''}`}
                          </td>
                        </tr>
                      )
                    })}
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">
                          Aucune entreprise ne correspond à « {filter.trim()} ».
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {/* Les cases cochées mais masquées par la recherche partent aussi. */}
            {[...selected]
              .filter((id) => !visible.some((candidate) => candidate.id === id))
              .map((id) => (
                <input key={id} type="hidden" name="clients" value={id} />
              ))}
          </div>
        )}
      </fieldset>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
        <div>
          <label htmlFor="subject" className="block text-sm font-medium">
            Objet
          </label>
          <input
            id="subject"
            name="subject"
            value={subject}
            onChange={(event) => {
              touch()
              setSubject(event.target.value)
            }}
            maxLength={BROADCAST_SUBJECT_MAX}
            autoComplete="off"
            aria-invalid={errors.subject ? true : undefined}
            aria-describedby={errors.subject ? 'subject-error' : undefined}
            className={fieldClass}
          />
          <FieldError id="subject-error" error={errors.subject} />
        </div>
        <div>
          <label htmlFor="body" className="block text-sm font-medium">
            Texte du message
          </label>
          <p id="body-hint" className="text-xs text-muted-foreground">
            Le courriel commence par « Bonjour, » et finit par le nom du centre, puis le lien pour ne plus
            recevoir ces informations : ne les écrivez pas. Texte brut, sans mise en forme ni pièce jointe.
          </p>
          <textarea
            id="body"
            name="body"
            rows={10}
            value={body}
            onChange={(event) => {
              touch()
              setBody(event.target.value)
            }}
            maxLength={BROADCAST_BODY_MAX}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby={`body-hint body-count${errors.body ? ' body-error' : ''}`}
            className={`${fieldClass} leading-relaxed`}
          />
          <p id="body-count" className="mt-1 text-xs text-muted-foreground tabular">
            {body.length.toLocaleString('fr-FR')} / {BROADCAST_BODY_MAX.toLocaleString('fr-FR')} caractères
          </p>
          <FieldError id="body-error" error={errors.body} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" name="intent" value="apercu" disabled={pending} className={confirmable ? secondaryButton : primaryButton}>
            {confirmable ? 'Actualiser l’aperçu' : 'Voir l’aperçu'}
          </button>
          {pending && (
            <p role="status" className="text-sm text-muted-foreground">
              Préparation…
            </p>
          )}
        </div>
      </div>

      {preview && (
        <section
          aria-labelledby="apercu-titre"
          className="flex flex-col gap-4 rounded-lg border border-accent/40 bg-white px-5 py-4"
        >
          <h2
            id="apercu-titre"
            ref={previewRef}
            tabIndex={-1}
            className="text-base font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Aperçu avant envoi
          </h2>
          {state?.notice && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
              <TriangleAlertIcon size={20} className="shrink-0 text-primary" />
              {state.notice}
            </p>
          )}
          <p className="flex items-start gap-2 text-sm">
            <UsersIcon size={20} className="shrink-0 text-primary" />
            <span>
              <span className="font-medium">À {audiencePhrase(preview.audience)}.</span>{' '}
              {preview.audience.renounced > 0 &&
                `${preview.audience.renounced} personne${preview.audience.renounced > 1 ? 's ont' : ' a'} décoché « Informations du centre » et ne le recevr${preview.audience.renounced > 1 ? 'ont' : 'a'} pas. `}
              {preview.audience.unreached > 0 &&
                `${preview.audience.unreached} entreprise${preview.audience.unreached > 1 ? 's' : ''} sans personne pour le recevoir (aucun accès à l’espace client, ou préférence coupée).`}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Parmi elles : {preview.sample.join(', ')}
            {preview.audience.companies > preview.sample.length &&
              ` et ${preview.audience.companies - preview.sample.length} autre${preview.audience.companies - preview.sample.length > 1 ? 's' : ''}`}
            .
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
              <TriangleAlertIcon size={20} className="shrink-0 text-primary" />
              {warning}
            </p>
          ))}
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Objet</dt>
              <dd className="font-medium break-words">{preview.subject}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Texte, tel que le recevra {preview.sample[0] ?? 'la première entreprise'}
              </dt>
              <dd className="mt-1 max-w-[75ch] whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 leading-relaxed">
                {preview.body}
              </dd>
            </div>
          </dl>
          {confirmable ? (
            <div className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="digest" value={preview.digest} />
              <button type="submit" name="intent" value="envoyer" disabled={pending} className={primaryButton}>
                <MailIcon size={20} />
                Envoyer à {audiencePhrase(preview.audience)}
              </button>
              <p className="text-xs text-muted-foreground">
                L’envoi part par paquets ; l’écran suivant montre son avancement.
              </p>
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Vous avez modifié le message ou ses destinataires : actualisez l’aperçu avant d’envoyer.
            </p>
          )}
        </section>
      )}
    </form>
  )
}
