'use client'

import { useActionState } from 'react'

import { CheckIcon } from '../../components/ui/icons.tsx'
import { updateMailSenderAction, type SenderFormState } from './actions.ts'
import { MAX_SENDER_LENGTH } from './expediteurs.ts'

/**
 * Suggestions d'expéditeurs (ADR 058) : un `<datalist>` natif, que le
 * navigateur filtre au fil de la frappe, au clavier comme au doigt. Aucune
 * lecture automatique : l'accueil tape, ou choisit.
 */
export function SenderDatalist({ id, senders }: { id: string; senders: readonly string[] }) {
  return (
    <datalist id={id}>
      {senders.map((sender) => (
        <option key={sender} value={sender} />
      ))}
    </datalist>
  )
}

const inputClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'

/**
 * Expéditeur d'un pli, précisé ou corrigé après l'enregistrement (ADR 058) :
 * sur la fiche du pli (`layout="fiche"`, libellé visible au-dessus) ou dans
 * le tableau de la tournée (`layout="ligne"`, libellé porté par l'en-tête de
 * colonne et la ligne, `labelledBy`). L'écran reste en place, le résultat est
 * annoncé à côté du champ.
 */
export function SenderForm({
  mailItemId,
  sender,
  listId,
  layout,
  labelledBy,
}: {
  mailItemId: string
  sender: string | null
  /** `<datalist>` des suggestions, rendue une fois dans la page. */
  listId: string
  layout: 'fiche' | 'ligne'
  /** Ligne du tableau : identifiants de l'en-tête de colonne et de la ligne. */
  labelledBy?: string
}) {
  const [state, formAction, pending] = useActionState<SenderFormState, FormData>(updateMailSenderAction, null)
  const fieldId = `expediteur-${mailItemId}`
  const error = state?.fieldErrors?.sender ?? state?.error
  const saved = state?.saved !== undefined && !error
  const describedBy = [layout === 'fiche' && `${fieldId}-aide`, error && `${fieldId}-erreur`].filter(Boolean).join(' ')

  return (
    // Remonté quand l'expéditeur enregistré change, ou après un refus : le
    // champ repart de l'enregistré, ou de la saisie refusée, à corriger.
    <form key={`${sender ?? ''}|${state?.rejected ?? ''}`} action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={mailItemId} />
      {layout === 'fiche' && (
        <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
          Expéditeur <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
      )}
      <div className={`flex gap-2 ${layout === 'fiche' ? 'flex-wrap' : 'min-w-56'}`}>
        <input
          id={fieldId}
          name="sender"
          list={listId}
          defaultValue={state?.rejected ?? sender ?? ''}
          autoComplete="off"
          maxLength={MAX_SENDER_LENGTH}
          aria-labelledby={layout === 'ligne' ? labelledBy : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`${inputClass} ${layout === 'fiche' ? 'max-w-sm flex-1' : 'min-w-0 flex-1 py-1.5'}`}
        />
        <button
          type="submit"
          disabled={pending}
          className={`shrink-0 rounded-md border border-border bg-white px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${layout === 'fiche' ? 'min-h-11 sm:min-h-10' : 'min-h-8'}`}
        >
          {pending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
      {layout === 'fiche' && (
        <p id={`${fieldId}-aide`} className="text-xs text-muted-foreground">
          Tel qu’il figure sur l’enveloppe ; tapez ou choisissez dans la liste. Le client le voit dans son
          espace. Champ vide : l’expéditeur est effacé.
        </p>
      )}
      {error && (
        <p id={`${fieldId}-erreur`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {saved && (
          <span className="inline-flex items-center gap-1">
            <CheckIcon size={14} />
            {state?.saved ? 'Expéditeur enregistré.' : 'Expéditeur effacé.'}
          </span>
        )}
      </p>
    </form>
  )
}
