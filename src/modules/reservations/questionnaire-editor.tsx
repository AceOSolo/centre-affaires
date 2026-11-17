'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { FieldLabel, RequiredNote } from '../../components/ui/obligatoire.tsx'
import {
  dangerButtonClass,
  describedBy,
  FieldError,
  FieldHint,
  fieldClass,
  labelClass,
  PendingAnnouncement,
  primaryButtonClass,
  secondaryButtonClass,
  SuccessNotice,
} from '../facturation/champs.tsx'
import { formatCents } from '../facturation/tarifs.ts'
import {
  resetQuestionsAction,
  saveDomiciliationOptionsAction,
  savePresentationAction,
  saveQuestionAction,
  type FormEditState,
} from './questionnaires-actions.ts'
import { conditionSources, questionFormValues, questionTokens, type QuestionFormValues } from './questionnaires-edition.ts'
import { questionKindLabels, questionKinds, type Formulaire, type Question } from './questionnaires.ts'

/**
 * Formulaires de l'écran « Formulaires de demande » (ADR 074) : la
 * présentation du service, une question, les options de la domiciliation.
 * Dense, desktop d'abord (back-office) ; chaque champ a son libellé, son
 * erreur en ligne et sa place dans le résumé d'erreurs (`CLAUDE.md`).
 */

const presentationLabels = { label: 'Nom du service', description: 'Présentation' }

export function PresentationForm({ form, label, description }: { form: Formulaire; label: string; description: string }) {
  const [state, formAction, pending] = useActionState<FormEditState, FormData>(savePresentationAction, null)
  const errors = state?.fieldErrors ?? {}
  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="formulaire" value={form} />
      <ErrorSummary errors={state?.fieldErrors} labels={presentationLabels} message={state?.message} />
      {state?.ok && <SuccessNotice>{state.ok}</SuccessNotice>}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <FieldLabel htmlFor="label" required className={labelClass}>Nom du service</FieldLabel>
          <input id="label" name="label" required aria-required="true" maxLength={120} defaultValue={label} {...describedBy('label', errors.label)} className={`${fieldClass} mt-1`} />
          <FieldError name="label" error={errors.label} />
        </div>
        <div>
          <FieldLabel htmlFor="description" required className={labelClass}>Présentation</FieldLabel>
          <input id="description" name="description" required aria-required="true" maxLength={300} defaultValue={description} {...describedBy('description', errors.description, true)} className={`${fieldClass} mt-1`} />
          <FieldError name="description" error={errors.description} />
          <FieldHint name="description">La phrase sous le nom, quand le visiteur choisit ce qu’il réserve.</FieldHint>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>{pending ? 'Enregistrement…' : 'Enregistrer la présentation'}</button>
        <PendingAnnouncement pending={pending} label="Enregistrement de la présentation en cours" />
      </div>
    </form>
  )
}

const questionLabels: Record<string, string> = {
  label: 'Question',
  kind: 'Type de réponse',
  hint: 'Aide',
  choices: 'Choix proposés',
  min: 'Minimum',
  max: 'Maximum',
  maxLength: 'Longueur maximale',
  condition: 'Affichage',
}

/** Montre les réglages du type choisi, sans JavaScript : la liste déroulante pilote la feuille. */
const kindStyles = [
  '[data-question-form] [data-pour] { display: none; }',
  ...questionKinds.map((kind) => `[data-question-form]:has(select[name="kind"] option[value="${kind}"]:checked) [data-pour~="${kind}"] { display: block; }`),
].join('\n')

/**
 * Ajout ou modification d'une question. Le nom stable d'une question existante
 * ne change jamais ; celui d'une nouvelle vient de son libellé.
 */
export function QuestionForm({ form, question, questions }: {
  form: Formulaire
  /** La question modifiée ; absente pour une nouvelle. */
  question?: Question
  questions: readonly Question[]
}) {
  const [state, formAction, pending] = useActionState<FormEditState, FormData>(saveQuestionAction, null)
  const values: QuestionFormValues = state?.values ?? questionFormValues(question)
  const errors = state?.fieldErrors ?? {}
  const sources = conditionSources(questions, question?.name)
  const removed = new Set(values.removedChoices)
  return (
    <form action={formAction} noValidate data-question-form className="flex flex-col gap-5">
      <style dangerouslySetInnerHTML={{ __html: kindStyles }} />
      <input type="hidden" name="formulaire" value={form} />
      <input type="hidden" name="nom" value={question?.name ?? ''} />
      <ErrorSummary errors={state?.fieldErrors} labels={questionLabels} message={state?.message} />
      <RequiredNote />

      <div key={JSON.stringify(values)} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div>
            <FieldLabel htmlFor="label" required className={labelClass}>Question</FieldLabel>
            <input id="label" name="label" required aria-required="true" maxLength={200} defaultValue={values.label} {...describedBy('label', errors.label)} className={`${fieldClass} mt-1`} />
            <FieldError name="label" error={errors.label} />
          </div>
          <div>
            <FieldLabel htmlFor="kind" required className={labelClass}>Type de réponse</FieldLabel>
            <select id="kind" name="kind" required aria-required="true" defaultValue={values.kind} {...describedBy('kind', errors.kind)} className={`${fieldClass} mt-1`}>
              {questionKinds.map((kind) => <option key={kind} value={kind}>{questionKindLabels[kind]}</option>)}
            </select>
            <FieldError name="kind" error={errors.kind} />
          </div>
        </div>

        <div>
          <label htmlFor="hint" className={labelClass}>Aide</label>
          <input id="hint" name="hint" maxLength={300} defaultValue={values.hint} {...describedBy('hint', errors.hint, true)} className={`${fieldClass} mt-1`} />
          <FieldError name="hint" error={errors.hint} />
          <FieldHint name="hint">Une phrase sous la question : où trouver l’information, ce qu’on en fera.</FieldHint>
        </div>

        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input type="checkbox" name="required" defaultChecked={values.required} className="size-4 accent-primary" />
          Réponse obligatoire
        </label>

        <fieldset data-pour="choice multi" id="choices" tabIndex={-1} className="rounded-lg border border-border px-4 py-3">
          <legend className="px-1 text-sm font-semibold">Choix proposés</legend>
          {Object.keys(values.choiceLabels).length > 0 && (
            <ul className="mt-2 flex flex-col gap-2">
              {Object.entries(values.choiceLabels).map(([value, label]) => (
                <li key={value} className="flex flex-wrap items-center gap-3">
                  <label htmlFor={`choix.${value}`} className="sr-only">Libellé du choix « {label} »</label>
                  <input id={`choix.${value}`} name={`choix.${value}`} defaultValue={label} maxLength={120} className={`${fieldClass} max-w-md`} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="retirer" value={value} defaultChecked={removed.has(value)} className="size-4 accent-primary" />
                    Retirer
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <label htmlFor="newChoices" className={labelClass}>{Object.keys(values.choiceLabels).length > 0 ? 'Choix à ajouter' : 'Choix'}</label>
            <textarea id="newChoices" name="newChoices" rows={4} defaultValue={values.newChoices} {...describedBy('newChoices', undefined, true)} className={`${fieldClass} mt-1`} />
            <FieldHint name="newChoices">Un choix par ligne.</FieldHint>
          </div>
          <label className="mt-3 flex min-h-6 items-center gap-2 text-sm">
            <input type="checkbox" name="allowOther" defaultChecked={values.allowOther} className="size-4 accent-primary" />
            Proposer « Autre », qui ouvre un champ libre
          </label>
          <FieldError name="choices" error={errors.choices} />
        </fieldset>

        <div data-pour="integer" className="grid max-w-md gap-4 sm:grid-cols-2">
          {(['min', 'max'] as const).map((key) => (
            <div key={key}>
              <label htmlFor={key} className={labelClass}>{key === 'min' ? 'Minimum' : 'Maximum'}</label>
              <input id={key} name={key} inputMode="numeric" defaultValue={values[key]} {...describedBy(key, errors[key])} className={`${fieldClass} mt-1 tabular`} />
              <FieldError name={key} error={errors[key]} />
            </div>
          ))}
        </div>

        <div data-pour="text textarea" className="max-w-xs">
          <label htmlFor="maxLength" className={labelClass}>Longueur maximale</label>
          <input id="maxLength" name="maxLength" inputMode="numeric" defaultValue={values.maxLength} {...describedBy('maxLength', errors.maxLength, true)} className={`${fieldClass} mt-1 tabular`} />
          <FieldError name="maxLength" error={errors.maxLength} />
          <FieldHint name="maxLength">En caractères ; vide : 200 pour un texte court, 2 000 pour un texte long.</FieldHint>
        </div>

        <label data-pour="date" className="min-h-6 items-center gap-2 text-sm">
          <input type="checkbox" name="notBeforeToday" defaultChecked={values.notBeforeToday} className="mr-2 size-4 align-middle accent-primary" />
          Refuser les jours passés
        </label>

        <fieldset id="condition" tabIndex={-1} className="rounded-lg border border-border px-4 py-3" {...describedBy('condition', errors.condition, true)}>
          <legend className="px-1 text-sm font-semibold">Afficher cette question seulement si…</legend>
          <FieldHint name="condition">Rien de coché : la question est toujours posée. Cochée, elle n’est posée, et exigée si elle est obligatoire, que pour ces réponses.</FieldHint>
          {sources.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Aucune question à choix n’est posée avant celle-ci.</p>
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {sources.map((source) => (
                <fieldset key={source.name}>
                  <legend className="text-sm font-medium">{source.label}</legend>
                  <div className="mt-1 flex flex-col gap-1">
                    {questionTokens(source).map((token) => {
                      const pair = `${source.name}:${token.value}`
                      return (
                        <label key={pair} className="flex min-h-6 items-center gap-2 text-sm">
                          <input type="checkbox" name="condition" value={pair} defaultChecked={values.condition.includes(pair)} className="size-4 accent-primary" />
                          {token.label}
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
          <FieldError name="condition" error={errors.condition} />
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>{pending ? 'Enregistrement…' : question ? 'Enregistrer la question' : 'Ajouter la question'}</button>
        <Link href={`/reglages/formulaires/${form}`} className={secondaryButtonClass}>Annuler</Link>
        <PendingAnnouncement pending={pending} label="Enregistrement de la question en cours" />
      </div>
    </form>
  )
}

/** Revenir aux questions du code : le centre repart des questions par défaut. */
export function ResetQuestionsButton({ form }: { form: Formulaire }) {
  return (
    <ConfirmDialog
      triggerLabel="Revenir aux questions par défaut"
      triggerClassName={dangerButtonClass}
      title="Revenir aux questions par défaut ?"
      confirmLabel="Revenir aux questions par défaut"
      pendingLabel="Retour aux questions par défaut…"
      action={resetQuestionsAction}
      fields={{ formulaire: form }}
    >
      <p>
        Les questions ajoutées, modifiées ou masquées sont remplacées par celles d’origine. Le nom du service, sa
        présentation et les options restent. Les devis déjà reçus gardent les réponses telles que les demandeurs les
        ont lues.
      </p>
    </ConfirmDialog>
  )
}

export type OfferableServiceView = { code: string; name: string; description: string | null; unitPriceCents: number; currency: string }

/** Les forfaits mensuels du catalogue que le formulaire de domiciliation propose en option. */
export function DomiciliationOptionsForm({ services, selected }: { services: readonly OfferableServiceView[]; selected: readonly string[] }) {
  const [state, formAction, pending] = useActionState<FormEditState, FormData>(saveDomiciliationOptionsAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <ErrorSummary labels={{}} message={state?.message} />
      {state?.ok && <SuccessNotice>{state.ok}</SuccessNotice>}
      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun forfait mensuel au catalogue. Les services arrivent de Dolibarr (ADR 049) ; un service saisi à l’écran
          Services, au mois et avec un code, peut aussi être proposé.
        </p>
      ) : (
        <fieldset>
          <legend className="sr-only">Options proposées</legend>
          <ul className="flex flex-col gap-2">
            {services.map((service) => (
              <li key={service.code}>
                <label className="flex min-h-6 items-start gap-2 text-sm">
                  <input type="checkbox" name="services" value={service.code} defaultChecked={selected.includes(service.code)} className="mt-0.5 size-4 accent-primary" />
                  <span>
                    <span className="font-medium">{service.name}</span>
                    <span className="tabular text-muted-foreground"> — {formatCents(service.unitPriceCents, service.currency)} HT par mois</span>
                    <span className="block text-xs text-muted-foreground">Référence {service.code}{service.description ? ` · ${service.description}` : ''}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || services.length === 0} className={primaryButtonClass}>{pending ? 'Enregistrement…' : 'Enregistrer les options'}</button>
        <PendingAnnouncement pending={pending} label="Enregistrement des options en cours" />
      </div>
    </form>
  )
}
