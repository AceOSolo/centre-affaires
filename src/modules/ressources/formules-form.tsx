'use client'

import { useActionState } from 'react'

import { updateRentalFormulasAction, type RentalFormulasState } from './formules-actions.ts'
import {
  formulaFieldName,
  rentalFormulaDescriptions,
  rentalFormulaLabels,
  rentalFormulas,
  type RentalFormula,
} from './formules.ts'

/**
 * Formules de location d'un bureau, sur sa fiche (ADR 076) : coworking (à
 * l'heure, à la demi-journée, à la journée) ou longue durée (à la semaine, au
 * mois). Le formulaire de demande — page publique et espace client — ne
 * propose que les formules cochées, et le prix suit leur unité
 * (`tarif.bureau.<unité>`, ADR 049).
 */
export function RentalFormulasForm({ resourceId, formulas }: { resourceId: string; formulas: readonly RentalFormula[] }) {
  const [state, formAction, pending] = useActionState<RentalFormulasState, FormData>(updateRentalFormulasAction, null)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={resourceId} />
      <fieldset className="flex flex-col gap-2" aria-describedby="formules-aide">
        <legend className="mb-1 text-sm text-muted-foreground">
          Formules proposées au client, en ligne :
        </legend>
        {rentalFormulas.map((formula) => (
          <label
            key={formula}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-accent/5"
          >
            <input
              type="checkbox"
              name={formulaFieldName(formula)}
              value="on"
              defaultChecked={formulas.includes(formula)}
              className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <span className="text-sm">
              <span className="block font-medium">{rentalFormulaLabels[formula]}</span>
              <span className="block text-muted-foreground">{rentalFormulaDescriptions[formula]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p id="formules-aide" className="text-xs text-muted-foreground">
        Aucune case cochée : le formulaire reste libre (début et fin au choix, tarif le moins cher). Le prix de
        chaque formule vient de Dolibarr : références <span className="tabular">tarif.bureau.heure</span>,{' '}
        <span className="tabular">demi-journee</span>, <span className="tabular">journee</span>,{' '}
        <span className="tabular">semaine</span>, <span className="tabular">mois</span>. Sans prix, le client lit
        « tarif communiqué par l’accueil ». Les plafonds à la semaine et au mois se règlent dans Disponibilités.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer les formules'}
        </button>
        <p aria-live="polite" className="text-sm empty:hidden">
          {pending && <span className="sr-only">Enregistrement en cours.</span>}
          {!pending && state?.ok && <span className="text-primary">{state.ok}</span>}
          {!pending && state?.error && <span className="text-destructive">{state.error}</span>}
        </p>
      </div>
    </form>
  )
}
