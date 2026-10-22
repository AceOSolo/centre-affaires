'use client'

import { useActionState } from 'react'

import { teamRowAction, type TeamRowState } from '../../../lib/auth/equipe-actions.ts'

const controlClass =
  'rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Actions d'une ligne de l'équipe : changer de rôle, retirer. Un seul
 * formulaire, deux boutons qui disent leur intention ; l'état — envoi, puis
 * résultat — s'affiche près d'eux, dans une région annoncée.
 *
 * Le choix du rôle n'apparaît que si l'auteur peut en donner un autre : la
 * direction, qui a trois rôles en main (ADR 054). L'exploitant, qui n'inscrit
 * que l'accueil, ne voit que le retrait.
 *
 * Le serveur décide : un refus (réservé à la direction, soi-même) revient ici
 * en message, même si l'écran n'avait pas masqué le bouton.
 */
export function TeamRowActions({
  memberId,
  name,
  roles,
}: {
  memberId: string
  /** Nom ou adresse, pour des libellés de bouton qui disent de qui il s'agit. */
  name: string
  /** Les rôles que l'auteur peut donner à ce membre, le sien excepté. */
  roles: { value: string; label: string }[]
}) {
  const [state, formAction, pending] = useActionState<TeamRowState, FormData>(teamRowAction, null)
  const selectId = `role-${memberId}`

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={memberId} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {roles.length > 0 && (
          <>
            <label htmlFor={selectId} className="text-xs text-muted-foreground">
              Nouveau rôle
              <span className="sr-only"> de {name}</span>
            </label>
            <select id={selectId} name="role" disabled={pending} className={`${controlClass} bg-white`}>
              {roles.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
            <button type="submit" name="intent" value="role" disabled={pending} className={controlClass}>
              Changer le rôle
              {/* Le nom complète le libellé visible, sans le contredire. */}
              <span className="sr-only"> : {name}</span>
            </button>
          </>
        )}
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
