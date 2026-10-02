'use client'

import { useActionState } from 'react'

import { teamRowAction, type TeamRowState } from '../../../lib/auth/equipe-actions.ts'

/**
 * Actions d'une ligne de l'équipe : changer de rôle, retirer. Un seul
 * formulaire, deux boutons qui disent leur intention ; l'état — envoi, puis
 * résultat — s'affiche près d'eux, dans une région annoncée.
 *
 * Le serveur décide : un refus (dernier exploitant, soi-même) revient ici en
 * message, même si l'écran n'avait pas masqué le bouton.
 */
export function TeamRowActions({
  memberId,
  name,
  nextRole,
}: {
  memberId: string
  /** Nom ou adresse, pour des libellés de bouton qui disent de qui il s'agit. */
  name: string
  /** Le rôle proposé par le bouton de bascule, avec son libellé. */
  nextRole: { value: string; label: string }
}) {
  const [state, formAction, pending] = useActionState<TeamRowState, FormData>(teamRowAction, null)

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={memberId} />
      <input type="hidden" name="role" value={nextRole.value} />
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="submit"
          name="intent"
          value="role"
          disabled={pending}
          className="rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Passer en {nextRole.label}
          {/* Le nom complète le libellé visible, sans le contredire. */}
          <span className="sr-only"> : {name}</span>
        </button>
        <button
          type="submit"
          name="intent"
          value="retrait"
          disabled={pending}
          className="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Retirer de l’équipe
          <span className="sr-only"> : {name}</span>
        </button>
      </div>
      <p aria-live="polite" className="max-w-xs text-right text-xs empty:hidden">
        {pending && <span className="text-muted-foreground">Enregistrement…</span>}
        {!pending && state?.ok && <span className="text-primary">{state.ok}</span>}
        {!pending && state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
