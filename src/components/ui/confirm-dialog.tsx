'use client'

import { useActionState, useEffect, useId, useRef } from 'react'

type ActionState = { error?: string } | null

/**
 * Confirmation d'une action lourde de conséquences, dans un dialogue modal.
 *
 * Bâti sur `<dialog>` et `showModal()`, natifs, plutôt qu'une dépendance : le
 * navigateur rend le reste de la page inerte, retient la tabulation dans le
 * dialogue et le ferme sur Échap. Le focus va sur « Annuler » à l'ouverture —
 * le choix sans conséquence d'abord — et revient au bouton déclencheur à la
 * fermeture, quelle qu'en soit la cause.
 *
 * L'action est une action serveur au format de `useActionState` : elle
 * redirige en cas de succès, ou rend `{ error }`, affichée dans le dialogue et
 * annoncée.
 */
export function ConfirmDialog({
  triggerLabel,
  triggerAriaLabel,
  triggerClassName,
  title,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = 'Annuler',
  action,
  fields,
}: {
  triggerLabel: string
  /** Nom accessible du déclencheur, quand le libellé seul se répète d'une ligne à l'autre. */
  triggerAriaLabel?: string
  triggerClassName?: string
  title: string
  /** Ce que l'action va faire, et ce qui reste possible après. */
  children: React.ReactNode
  confirmLabel: string
  pendingLabel: string
  cancelLabel?: string
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>
  /** Champs cachés envoyés avec la confirmation, l'identifiant par exemple. */
  fields: Record<string, string>
}) {
  const [state, formAction, pending] = useActionState(action, null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // Échap, « Annuler » ou fin d'action : le focus revient d'où l'on vient.
    const onClose = () => triggerRef.current?.focus()
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [])

  function open() {
    dialogRef.current?.showModal()
    cancelRef.current?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-label={triggerAriaLabel}
        className={triggerClassName}
      >
        {triggerLabel}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-white p-6 text-foreground shadow-lg backdrop:bg-foreground/40"
      >
        <form action={formAction} className="flex flex-col gap-4">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <div id={descriptionId} className="flex flex-col gap-2 text-sm">
            {children}
          </div>

          {state?.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {state.error}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            <button
              ref={cancelRef}
              type="button"
              onClick={() => dialogRef.current?.close()}
              disabled={pending}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-destructive/30 bg-white px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {pending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
