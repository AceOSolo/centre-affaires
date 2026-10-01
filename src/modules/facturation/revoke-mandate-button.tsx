'use client'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { revokeMandateAction } from './mandats-actions.ts'

/** Révocation d'un mandat actif : il ne sert plus, sa RUM n'est jamais réattribuée. */
export function RevokeMandateButton({
  clientId,
  mandateId,
  reference,
}: {
  clientId: string
  mandateId: string
  reference: string
}) {
  return (
    <ConfirmDialog
      triggerLabel="Révoquer"
      triggerAriaLabel={`Révoquer le mandat ${reference}`}
      triggerClassName="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      title={`Révoquer le mandat ${reference} ?`}
      confirmLabel="Révoquer le mandat"
      pendingLabel="Révocation…"
      action={revokeMandateAction}
      fields={{ clientId, mandateId }}
    >
      <p>
        Le centre ne pourra plus prélever ce compte. Les factures déjà émises en prélèvement sur ce
        mandat resteront à régler par un autre moyen.
      </p>
      <p>Le mandat reste dans l’historique du client ; sa référence ne sera jamais réutilisée.</p>
    </ConfirmDialog>
  )
}
