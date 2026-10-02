'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { registerMailAction, type MailFormState } from './actions.ts'
import { MAX_SCAN_BYTES, SCAN_ACCEPT } from './fichiers.ts'
import { mailKindLabels } from './labels.ts'
import { mailKinds } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

const labels: Record<string, string> = {
  clientId: 'Destinataire',
  kind: 'Type',
  sender: 'Expéditeur',
  receivedAt: 'Reçu le',
  note: 'Précision pour le client',
  envelope: 'Enveloppe',
  content: 'Contenu',
}

/**
 * Enregistrement d'un pli à son arrivée.
 *
 * Pensé pour la tournée du matin : après chaque enregistrement le formulaire
 * revient vide, le suivant se saisit sans repasser par la liste.
 */
export function MailForm({
  clients,
  defaultClientId,
  defaultReceivedAt,
}: {
  clients: { id: string; name: string }[]
  defaultClientId?: string
  /** Heure murale du centre, au format `datetime-local`. */
  defaultReceivedAt: string
}) {
  const [state, formAction, pending] = useActionState<MailFormState, FormData>(
    registerMailAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}
  const values = state?.values

  return (
    // Remonté après un échec pour reprendre les valeurs saisies : React
    // réinitialise le formulaire à la fin de chaque envoi.
    <form key={JSON.stringify(values ?? {})} action={formAction} className="flex max-w-3xl flex-col gap-5">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className={labelClass} htmlFor="clientId">
            Destinataire
          </label>
          <select
            id="clientId"
            name="clientId"
            required
            defaultValue={values?.clientId ?? defaultClientId ?? ''}
            aria-invalid={errors.clientId ? true : undefined}
            aria-describedby={errors.clientId ? 'clientId-error' : undefined}
            className={`${fieldClass} mt-1`}
          >
            <option value="" disabled>
              Choisir un client…
            </option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <FieldError name="clientId" error={errors.clientId} />
        </div>

        <div>
          <label className={labelClass} htmlFor="kind">
            Type
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue={values?.kind ?? 'lettre'}
            className={`${fieldClass} mt-1`}
          >
            {mailKinds.map((kind) => (
              <option key={kind} value={kind}>
                {mailKindLabels[kind]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className={labelClass} htmlFor="sender">
            Expéditeur <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            id="sender"
            name="sender"
            defaultValue={values?.sender ?? ''}
            aria-describedby="sender-hint"
            className={`${fieldClass} mt-1`}
          />
          <p id="sender-hint" className="mt-1 text-xs text-muted-foreground">
            Tel qu’il figure sur l’enveloppe.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="receivedAt">
            Reçu le
          </label>
          <input
            id="receivedAt"
            name="receivedAt"
            type="datetime-local"
            required
            defaultValue={values?.receivedAt ?? defaultReceivedAt}
            aria-invalid={errors.receivedAt ? true : undefined}
            aria-describedby={errors.receivedAt ? 'receivedAt-error' : undefined}
            className={`${fieldClass} mt-1 tabular`}
          />
          <FieldError name="receivedAt" error={errors.receivedAt} />
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="note">
          Précision pour le client{' '}
          <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="note"
          name="note"
          rows={2}
          defaultValue={values?.note ?? ''}
          aria-describedby="note-hint"
          className={`${fieldClass} mt-1`}
        />
        <p id="note-hint" className="mt-1 text-xs text-muted-foreground">
          Visible par le client. Par exemple : avis de passage, à retirer avant le 12.
        </p>
      </div>

      <fieldset className="flex flex-col gap-5 rounded-lg border border-border bg-white px-5 py-4">
        <legend className="px-1 text-sm font-semibold tracking-tight">Numérisations</legend>
        <p className="-mt-2 text-xs text-muted-foreground">
          PDF, JPEG ou PNG, {MAX_SCAN_BYTES / 1024 / 1024} Mo au plus par fichier. Un fichier
          refusé est à joindre de nouveau.
        </p>

        <FileField
          name="envelope"
          label="Enveloppe"
          hint="Le recto, pour que le client décide s’il veut faire ouvrir le pli."
          error={errors.envelope}
        />
        <FileField
          name="content"
          label="Contenu"
          hint="Seulement si le pli est ouvert maintenant. L’ouverture sera comptée au relevé de facturation, à l’initiative du centre."
          error={errors.content}
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer le courrier'}
        </button>
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          Retour au courrier
        </Link>
      </div>
    </form>
  )
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

export function FileField({
  name,
  label,
  hint,
  error,
  required,
}: {
  name: string
  label: string
  hint: string
  error?: string
  required?: boolean
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}{' '}
        {!required && <span className="font-normal text-muted-foreground">(facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        type="file"
        accept={SCAN_ACCEPT}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${name}-hint${error ? ` ${name}-error` : ''}`}
        className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
        {hint}
      </p>
      <FieldError name={name} error={error} />
    </div>
  )
}
