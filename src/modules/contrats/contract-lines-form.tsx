'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveContractLinesAction, type LinesFormState } from './lignes-actions.ts'
import type { LineFormValues } from './lignes.ts'
import { LinesEditor, lineErrorLabels, type LinesCatalog } from './lines-editor.tsx'

/**
 * Lignes d'un contrat brouillon (R12, ADR 025) : le formulaire envoie l'état
 * voulu, complet ; la base en déduit le montant du contrat. La saisie reste
 * dans l'état du composant après un refus.
 */
export function ContractLinesForm({
  contractId,
  initial,
  catalog,
  periodSuffix,
  currency,
}: {
  contractId: string
  initial: LineFormValues[]
  catalog: LinesCatalog
  periodSuffix: string
  currency: string
}) {
  const [state, formAction, pending] = useActionState<LinesFormState, FormData>(
    saveContractLinesAction,
    null,
  )
  const [lines, setLines] = useState(initial)
  const errors = state?.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <ErrorSummary errors={state?.fieldErrors} labels={lineErrorLabels(errors, lines)} message={state?.error} />
      <input type="hidden" name="id" value={contractId} />

      <LinesEditor
        lines={lines}
        setLines={setLines}
        catalog={catalog}
        errors={errors}
        periodSuffix={periodSuffix}
        currency={currency}
        emptyMessage="Aucune ligne : le montant saisi sur le brouillon fait foi. Ajoutez une ligne pour détailler le prix."
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer les lignes'}
        </button>
        <Link href={`/contrats/${contractId}`} className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Le montant du contrat devient la somme des lignes récurrentes. Une fois le contrat activé,
        ses lignes ne changent plus que par avenant.
      </p>
    </form>
  )
}
