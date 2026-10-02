'use client'

import { useId } from 'react'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { cancelPaymentAction } from './reglements-actions.ts'

/**
 * Annulation d'un pointage (ADR 027) : un paiement ne se supprime pas, il
 * s'annule avec un motif — erreur de saisie, prélèvement rejeté par la
 * banque. La ligne reste visible, barrée de son motif.
 */
export function CancelPaymentButton({
  invoiceId,
  paymentId,
  label,
}: {
  invoiceId: string
  paymentId: string
  /** « paiement de 120,00 € du 05/10/2026 », pour le nom accessible du bouton. */
  label: string
}) {
  const reasonId = useId()
  return (
    <ConfirmDialog
      triggerLabel="Annuler"
      triggerAriaLabel={`Annuler le ${label}`}
      triggerClassName="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      title="Annuler ce pointage ?"
      confirmLabel="Annuler le pointage"
      pendingLabel="Annulation…"
      cancelLabel="Garder le pointage"
      action={cancelPaymentAction}
      fields={{ invoiceId, paymentId }}
    >
      <p>
        Le {label} ne comptera plus dans le règlement de la facture. Il reste dans l’historique, avec
        le motif ci-dessous.
      </p>
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
          Motif
        </label>
        <textarea
          id={reasonId}
          name="reason"
          required
          rows={2}
          maxLength={500}
          className="mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Erreur de saisie, prélèvement rejeté (avec le code de rejet de la banque)…
        </p>
      </div>
    </ConfirmDialog>
  )
}
