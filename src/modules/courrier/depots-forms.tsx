'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  depositContentAction,
  discardContentAction,
  validateContentAction,
  type DepositFormState,
} from './depots-actions.ts'
import { PagesField } from './mail-form.tsx'
import { PhotosField } from './photos-field.tsx'

const primaryClass =
  'min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 sm:min-h-10'
const secondaryClass =
  'min-h-11 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 sm:min-h-10'

/** Où revenir après l'action : le traitement de la demande, ou la fiche du pli. */
export type DraftReturn = 'demande' | 'fiche'

/**
 * Dépôt du contenu d'un pli, à valider ensuite (ADR 079) : ouverture —
 * demandée ou d'office — ou numérisation demandée. Rien ne part vers le
 * client : l'écran montre ensuite l'aperçu et le bouton de validation.
 * `replace` : un dépôt attend déjà, celui-ci le remplace.
 */
export function DepositForm({
  mailItemId,
  requestId,
  purpose,
  replace = false,
}: {
  mailItemId: string
  requestId: string | null
  purpose: 'opening' | 'scan'
  replace?: boolean
}) {
  const [state, formAction, pending] = useActionState<DepositFormState, FormData>(depositContentAction, null)
  const field = replace ? 'Nouveau fichier' : purpose === 'scan' ? 'Numérisation' : 'Contenu'
  return (
    <form
      // Remonté avec la saisie rendue après un échec : React efface le formulaire.
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="mailItemId" value={mailItemId} />
      {requestId && <input type="hidden" name="requestId" value={requestId} />}
      <p className="text-xs text-muted-foreground">Les champs marqués * sont obligatoires.</p>
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ content: field, contentPages: 'Nombre de pages' }}
        message={state?.error}
      />
      <PhotosField
        name="content"
        label={field}
        hint={
          purpose === 'scan'
            ? 'Une photo lisible par page demandée, dans l’ordre, ou un PDF. Vous la relirez avant de la valider : le client ne la voit qu’après.'
            : 'Une photo lisible par page, dans l’ordre, ou le PDF de toutes les pages. Vous le relirez avant de le valider : le client ne le voit qu’après.'
        }
        error={state?.fieldErrors?.content}
        required
        multiple
      />
      <PagesField name="contentPages" error={state?.fieldErrors?.contentPages} defaultValue={state?.values?.contentPages} />
      <div>
        <button type="submit" disabled={pending} className={replace ? secondaryClass : primaryClass}>
          {pending ? 'Dépôt en cours…' : replace ? 'Remplacer le fichier' : 'Déposer et relire'}
        </button>
      </div>
    </form>
  )
}

/** « Valider et prévenir le client » : le seul geste qui publie le document. */
export function ValidateDraftButton({ draftId, back }: { draftId: string; back: DraftReturn }) {
  const [state, formAction, pending] = useActionState<DepositFormState, FormData>(validateContentAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="retour" value={back} />
      <ErrorSummary labels={{}} message={state?.error} />
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Validation…' : 'Valider et prévenir le client'}
        </button>
      </div>
    </form>
  )
}

/** Abandon d'un dépôt : rien n'est publié, la demande reste à traiter. */
export function DiscardDraftButton({ draftId, back }: { draftId: string; back: DraftReturn }) {
  const [state, formAction, pending] = useActionState<DepositFormState, FormData>(discardContentAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="retour" value={back} />
      <ErrorSummary labels={{}} message={state?.error} />
      <div>
        <button type="submit" disabled={pending} className={secondaryClass}>
          {pending ? 'Abandon…' : 'Abandonner ce dépôt'}
        </button>
      </div>
    </form>
  )
}
