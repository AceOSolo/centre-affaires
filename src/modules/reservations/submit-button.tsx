'use client'

import { useFormStatus } from 'react-dom'

/**
 * Bouton d'envoi qui dit qu'il travaille : toute soumission rend un état
 * (`CLAUDE.md`). Désactivé pendant l'envoi, ce qui évite aussi le double clic.
 *
 * Plusieurs boutons d'un même formulaire se distinguent par `formAction` :
 * seul celui qui a été actionné affiche son libellé d'attente.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
  formAction,
}: {
  children: React.ReactNode
  pendingLabel: string
  className?: string
  formAction?: (formData: FormData) => void | Promise<void>
}) {
  const { pending, action } = useFormStatus()
  const mine = pending && (!formAction || action === formAction)
  return (
    <button type="submit" formAction={formAction} disabled={pending} className={className}>
      {mine ? pendingLabel : children}
    </button>
  )
}
