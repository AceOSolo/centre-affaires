'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { createRatePlanAction, type FormState } from './actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/** Création d'une grille. Les prix s'ajoutent ensuite, ligne par ligne. */
export function RatePlanForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createRatePlanAction,
    null,
  )

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5">
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <div>
        <label className={labelClass} htmlFor="name">
          Nom de la grille
        </label>
        <input
          id="name"
          name="name"
          required
          placeholder="Tarifs publics 2026"
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="validFrom">
            Valable à partir du <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input id="validFrom" name="validFrom" type="date" className={`${fieldClass} mt-1`} />
        </div>
        <div>
          <label className={labelClass} htmlFor="validTo">
            Jusqu’au <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input id="validTo" name="validTo" type="date" className={`${fieldClass} mt-1`} />
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-border px-4 py-3">
        <input id="isDefault" name="isDefault" type="checkbox" className="mt-1" />
        <div>
          <label className="text-sm font-medium" htmlFor="isDefault">
            Grille par défaut du centre
          </label>
          <p className="text-xs text-muted-foreground">
            Appliquée aux contrats et aux réservations qui n’en désignent aucune. Une seule
            grille à la fois.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Créer la grille'}
        </button>
        <Link href="/tarifs" className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
      </div>
    </form>
  )
}
