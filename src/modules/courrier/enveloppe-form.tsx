'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { addEnvelopeAction, type MailFormState } from './actions.ts'
import { PhotosField } from './photos-field.tsx'

/**
 * Photo de l'enveloppe d'un pli qui n'en a pas (ADR 055) : compté en saisie
 * groupée, ou enregistré sans photo. Le client la voit aussitôt dans son
 * espace, sans nouveau message.
 */
export function EnvelopeForm({ mailItemId }: { mailItemId: string }) {
  const [state, formAction, pending] = useActionState<MailFormState, FormData>(addEnvelopeAction, null)

  return (
    <form
      id="enveloppe"
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={mailItemId} />
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Ajouter la photo de l’enveloppe</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Le client la voit dans son espace pour décider s’il fait ouvrir le pli. Il n’est pas
          prévenu une seconde fois.
        </p>
      </div>

      <ErrorSummary errors={state?.fieldErrors} labels={{ envelope: 'Enveloppe' }} message={state?.error} />

      <PhotosField
        name="envelope"
        label="Enveloppe"
        hint="Le recto : une photo, ou un fichier PDF, JPEG ou PNG de 10 Mo au plus."
        error={state?.fieldErrors?.envelope}
        required
      />

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Dépôt en cours…' : 'Ajouter la photo'}
        </button>
      </div>
    </form>
  )
}
