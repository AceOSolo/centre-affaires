'use client'

import { useActionState, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { QuestionnaireFields, questionnaireErrorLabels } from '../reservations/questionnaire-fields.tsx'
import { ANSWER_FIELD_PREFIX, questionnaires, type Answers } from '../reservations/questionnaires.ts'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  describedBy,
  fieldClass,
  labelClass,
  primaryButtonClass,
} from './champs.tsx'
import { createStaffProposalAction, type NewProposalFormState } from './propositions-actions.ts'
import { MAX_NOTE_LENGTH, requesterFieldLabels, type RequesterFormValues } from './propositions-ecran.ts'
import type { ProposalProduct } from './schema-devis.ts'

/**
 * Devis établi par l'accueil (ADR 043) : la réservation (espace, véhicule),
 * le destinataire, les réponses au questionnaire. Il naît brouillon : l'accueil
 * ajoute les lignes et le valide sur sa fiche.
 *
 * Champs contrôlés, ou remontés depuis la saisie renvoyée après un refus
 * (`key`) : React 19 vide les champs non contrôlés à chaque envoi.
 */
export function NewProposalForm({
  product,
  clients,
  bookings,
  fixedBooking,
  defaults,
}: {
  product: ProposalProduct
  clients: readonly { id: string; name: string }[]
  /** Réservations rattachables, pour un espace ou un véhicule ; vide pour une domiciliation. */
  bookings: readonly { id: string; label: string }[]
  /** Réservation imposée par `?reservation=`, affichée sans choix. */
  fixedBooking: { id: string; label: string } | null
  defaults: { requester: RequesterFormValues; answers: Answers; reservation: string }
}) {
  const [state, formAction, pending] = useActionState<NewProposalFormState, FormData>(createStaffProposalAction, null)
  const values = state?.values ?? defaults
  const fieldErrors = state?.fieldErrors ?? {}
  const answerErrors = Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([field]) => field.startsWith(ANSWER_FIELD_PREFIX))
      .map(([field, message]) => [field.slice(ANSWER_FIELD_PREFIX.length), message]),
  )
  const needsBooking = questionnaires[product].resourceTypes.length > 0

  return (
    <form action={formAction} noValidate className="flex flex-col gap-6">
      <input type="hidden" name="product" value={product} />

      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ ...requesterFieldLabels, reservation: 'Réservation', ...questionnaireErrorLabels(product) }}
        message={state?.message}
      />

      <div key={JSON.stringify(state?.values ?? '')} className="flex flex-col gap-6">
        {needsBooking && (
          <section aria-labelledby="reservation-titre" className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4">
            <h2 id="reservation-titre" className="text-sm font-semibold tracking-tight">
              Réservation
            </h2>
            {fixedBooking ? (
              <>
                <input type="hidden" name="reservation" value={fixedBooking.id} />
                <p className="text-sm">{fixedBooking.label}</p>
                <p className="text-xs text-muted-foreground">
                  Son prix figé devient la première ligne du devis, s’il existe.
                </p>
              </>
            ) : (
              <BookingSelect bookings={bookings} defaultValue={values.reservation} error={fieldErrors.reservation} />
            )}
          </section>
        )}

        <RecipientFields clients={clients} initial={values.requester} errors={fieldErrors} />

        <section aria-labelledby="questions-titre" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="questions-titre" className="text-sm font-semibold tracking-tight">
            Questions du devis
          </h2>
          <QuestionnaireFields product={product} defaults={values.answers} errors={answerErrors} density="compact" />
        </section>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? 'Création du devis…' : 'Créer le devis'}
        </button>
        <PendingAnnouncement pending={pending} label="Création du devis en cours" />
        <p className="text-sm text-muted-foreground">Il naît « À compléter » : vous le validerez sur sa fiche.</p>
      </div>
    </form>
  )
}

function BookingSelect({
  bookings,
  defaultValue,
  error,
}: {
  bookings: readonly { id: string; label: string }[]
  defaultValue: string
  error?: string
}) {
  const [value, setValue] = useState(defaultValue)
  return (
    <div>
      <label className={labelClass} htmlFor="reservation">
        Réservation à chiffrer
      </label>
      <select
        id="reservation"
        name="reservation"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        {...describedBy('reservation', error, true)}
        className={`${fieldClass} mt-1`}
      >
        <option value="">Choisir une réservation…</option>
        {bookings.map((booking) => (
          <option key={booking.id} value={booking.id}>
            {booking.label}
          </option>
        ))}
      </select>
      <FieldError name="reservation" error={error} />
      <FieldHint name="reservation">
        {bookings.length === 0
          ? 'Aucune réservation à venir sans devis : créez d’abord le créneau au planning, puis revenez ici depuis sa fiche.'
          : 'Réservations à venir, pas encore chiffrées en devis. Le prix figé de la réservation devient la première ligne.'}
      </FieldHint>
    </div>
  )
}

function RecipientFields({
  clients,
  initial,
  errors,
}: {
  clients: readonly { id: string; name: string }[]
  initial: RequesterFormValues
  errors: Record<string, string>
}) {
  const [values, setValues] = useState<RequesterFormValues>(
    clients.length === 0 ? { ...initial, recipient: 'prospect' } : initial,
  )
  const set = <K extends keyof RequesterFormValues>(key: K, value: RequesterFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))
  const isClient = values.recipient === 'client'

  const text = (
    name: 'requesterName' | 'requesterEmail' | 'requesterPhone' | 'requesterCompany',
    props: { type?: string; autoComplete?: string; optional?: boolean; maxLength?: number },
  ) => (
    <div>
      <label className={labelClass} htmlFor={name}>
        {requesterFieldLabels[name]}
        {props.optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
        {...describedBy(name, errors[name])}
        className={`${fieldClass} mt-1`}
      />
      <FieldError name={name} error={errors[name]} />
    </div>
  )

  return (
    <>
      <section aria-labelledby="destinataire-titre" className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="destinataire-titre" className="text-sm font-semibold tracking-tight">
          Destinataire
        </h2>
        <fieldset id="recipient" tabIndex={-1}>
          <legend className="sr-only">Destinataire du devis</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {(
              [
                ['client', 'Un client du centre'],
                ['prospect', 'Un nouveau demandeur'],
              ] as const
            ).map(([recipient, label]) => (
              <div key={recipient} className="flex items-center gap-2">
                <input
                  id={`recipient-${recipient}`}
                  type="radio"
                  name="recipient"
                  value={recipient}
                  checked={values.recipient === recipient}
                  disabled={recipient === 'client' && clients.length === 0}
                  onChange={() => set('recipient', recipient)}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <label htmlFor={`recipient-${recipient}`} className="text-sm">
                  {label}
                  {recipient === 'client' && clients.length === 0 && ' (aucun client enregistré)'}
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        {isClient && (
          <div>
            <label className={labelClass} htmlFor="clientId">
              Client
            </label>
            <select
              id="clientId"
              name="clientId"
              value={values.clientId}
              onChange={(event) => set('clientId', event.target.value)}
              {...describedBy('clientId', errors.clientId, true)}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Choisir un client…</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <FieldError name="clientId" error={errors.clientId} />
            <FieldHint name="clientId">Dolibarr rattache le devis à la fiche de ce client.</FieldHint>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {!isClient && text('requesterCompany', { autoComplete: 'organization', optional: true, maxLength: 255 })}
          {text('requesterName', { autoComplete: 'name', optional: isClient, maxLength: 255 })}
          {text('requesterEmail', { type: 'email', autoComplete: 'email', optional: isClient, maxLength: 320 })}
          {text('requesterPhone', { type: 'tel', autoComplete: 'tel', optional: true, maxLength: 40 })}
        </div>
        <p className="text-xs text-muted-foreground">
          {isClient
            ? 'Le contact, facultatif, précise à qui l’adresser dans l’entreprise.'
            : 'Le courriel est obligatoire, avec un nom ou une entreprise : Dolibarr crée le tiers à partir de ces champs.'}
        </p>
      </section>

      <section aria-labelledby="notes-titre" className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="notes-titre" className="text-sm font-semibold tracking-tight">
          Demande et note
        </h2>
        {(['message', 'staffNote'] as const).map((name) => (
          <div key={name}>
            <label className={labelClass} htmlFor={name}>
              {requesterFieldLabels[name]}{' '}
              <span className="font-normal text-muted-foreground">
                {name === 'message' ? '(facultatif, ce que le client a demandé)' : '(facultatif, transmise à Dolibarr)'}
              </span>
            </label>
            <textarea
              id={name}
              name={name}
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              value={values[name]}
              onChange={(event) => set(name, event.target.value)}
              {...describedBy(name, errors[name])}
              className={`${fieldClass} mt-1`}
            />
            <FieldError name={name} error={errors[name]} />
          </div>
        ))}
      </section>
    </>
  )
}
