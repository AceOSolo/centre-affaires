'use client'

import { useActionState } from 'react'

import { establishContractDocumentAction, type DocumentFormState } from './documents-actions.ts'

/**
 * Établit et archive le document d'un contrat engagé qui n'en a pas (activé
 * avant les documents, ou repris). L'état de l'envoi est rendu : chargement,
 * puis la fiche annonce le succès, ou l'erreur s'affiche ici.
 */
export function EstablishDocumentButton({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState<DocumentFormState, FormData>(
    establishContractDocumentAction,
    null,
  )
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={contractId} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? 'Archivage…' : 'Établir et archiver le document du contrat'}
      </button>
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}
    </form>
  )
}
