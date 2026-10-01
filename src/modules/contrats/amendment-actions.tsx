'use client'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { abandonAmendmentAction, signAmendmentAction } from './avenants-actions.ts'

/**
 * Signature d'un avenant, après confirmation : il prend effet à sa date, ne
 * se modifie plus, et son document est archivé (ADR 025). Un refus de la base
 * (date d'effet, ressource occupée) s'affiche dans le dialogue.
 */
export function SignAmendmentButton({
  contractId,
  amendmentId,
  number,
  summary,
}: {
  contractId: string
  amendmentId: string
  number: number
  /** Ce que l'avenant change, en une phrase. */
  summary: string
}) {
  return (
    <ConfirmDialog
      triggerLabel="Signer l’avenant…"
      triggerClassName="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
      title={`Signer l’avenant n° ${number} ?`}
      confirmLabel="Signer"
      pendingLabel="Signature…"
      action={signAmendmentAction}
      fields={{ contractId, amendmentId }}
    >
      <p>{summary}</p>
      <p>
        Une fois signé, l’avenant ne se modifie plus et son document est archivé avec son
        empreinte. Pour revenir dessus, il faudra un nouvel avenant.
      </p>
    </ConfirmDialog>
  )
}

/** Abandon d'un brouillon d'avenant : il ne compte plus, et reste consultable. */
export function AbandonAmendmentButton({
  contractId,
  amendmentId,
  number,
}: {
  contractId: string
  amendmentId: string
  number: number
}) {
  return (
    <ConfirmDialog
      triggerLabel="Abandonner le brouillon…"
      triggerClassName="rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
      title={`Abandonner l’avenant n° ${number} ?`}
      confirmLabel="Abandonner"
      pendingLabel="Abandon…"
      action={abandonAmendmentAction}
      fields={{ contractId, amendmentId }}
    >
      <p>
        Le brouillon ne pourra plus être signé ni modifié. Il reste consultable dans l’historique
        du contrat, avec son numéro.
      </p>
    </ConfirmDialog>
  )
}
