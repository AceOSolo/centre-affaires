'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { openMailAction, type MailFormState } from './actions.ts'
import { FileField } from './mail-form.tsx'

/**
 * Ouverture et numérisation d'un pli : la prestation facturée. Le fichier est
 * obligatoire — une ouverture sans numérisation laisserait le client payer
 * pour une boîte aux lettres vide.
 */
export function OpenForm({ mailItemId, requested }: { mailItemId: string; requested: boolean }) {
  const [state, formAction, pending] = useActionState<MailFormState, FormData>(
    openMailAction,
    null,
  )

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={mailItemId} />
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Ouvrir et numériser</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {requested
            ? 'Le client a demandé l’ouverture. Elle sera comptée au relevé comme sa demande.'
            : 'Ouverture à l’initiative du centre. Elle sera comptée au relevé comme telle.'}
        </p>
      </div>

      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ content: 'Contenu' }}
        message={state?.error}
      />

      <FileField
        name="content"
        label="Contenu"
        hint="PDF de toutes les pages, ou photo lisible. Le client y a accès dès l’enregistrement."
        error={state?.fieldErrors?.content}
        required
      />

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Dépôt en cours…' : 'Enregistrer l’ouverture'}
        </button>
      </div>
    </form>
  )
}
