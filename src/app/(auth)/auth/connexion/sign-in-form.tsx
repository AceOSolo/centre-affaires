'use client'

import { useState, useTransition } from 'react'

import { useRouter, useSearchParams } from 'next/navigation'

import { authClient } from '../../../../lib/auth/client.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30'
const labelClass = 'block text-sm font-medium text-foreground'

type Mode = 'connexion' | 'creation'

/**
 * Connexion de l'équipe du centre et des clients : un seul écran, un seul
 * compte Neon Auth, et `/auth/suite` oriente chacun vers son espace.
 *
 * Créer un compte ne donne aucun droit : l'accès dépend de `staff_members`
 * (ADR 008) ou de `client_members` (ADR 015). Un compte inconnu est renvoyé
 * vers `/auth/acces-refuse`, ce qui est volontaire — l'écran de connexion ne
 * doit pas révéler quelles adresses sont inscrites.
 */
export function SignInForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<Mode>('connexion')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // `proxy.ts` ajoute le chemin demandé ; on y revient une fois connecté.
  // Sans chemin, l'aiguillage choisit entre back-office et espace client.
  const redirectTo = searchParams.get('redirect') ?? '/auth/suite'

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const name = String(form.get('name') ?? '').trim()

    const repli =
      mode === 'creation'
        ? 'La création du compte a échoué.'
        : 'Adresse ou mot de passe incorrect.'

    // Le client d'authentification signale ses refus de deux façons selon le
    // cas : un `error` dans la réponse, ou une exception (`AuthApiError`) —
    // « User already exists », par exemple. Les deux doivent finir dans le
    // `role="alert"` du formulaire, jamais dans l'overlay d'erreur.
    try {
      const { error: authError } =
        mode === 'creation'
          ? await authClient.signUp.email({ email, password, name })
          : await authClient.signIn.email({ email, password })

      if (authError) {
        setError(authError.message ?? repli)
        return
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : repli)
      return
    }

    // `refresh` avant `replace` : la coque du back-office lit la session côté
    // serveur, elle doit être rejouée avec le cookie fraîchement posé.
    startTransition(() => {
      router.replace(redirectTo)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">
          {mode === 'creation' ? 'Créer votre accès' : 'Connexion'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === 'creation'
            ? 'Utilisez l’adresse professionnelle avec laquelle le centre vous a inscrit.'
            : 'Espace client et équipe du centre.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {mode === 'creation' && (
          <div>
            <label className={labelClass} htmlFor="name">
              Nom et prénom
            </label>
            <input
              id="name"
              name="name"
              required
              autoComplete="name"
              className={`${fieldClass} mt-1.5`}
            />
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="email">
            Adresse professionnelle
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="password">
            Mot de passe
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'creation' ? 'new-password' : 'current-password'}
            className={`${fieldClass} mt-1.5`}
          />
          {mode === 'creation' && (
            <p className="mt-1 text-xs text-muted-foreground">8 caractères au minimum.</p>
          )}
        </div>

        <button
          type="submit"
          disabled={pending}
          className="mt-1 rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending
            ? 'Un instant…'
            : mode === 'creation'
              ? 'Créer le compte'
              : 'Se connecter'}
        </button>
      </form>

      <p className="text-sm text-muted-foreground">
        {mode === 'creation' ? 'Vous avez déjà un compte ? ' : 'Première connexion ? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'creation' ? 'connexion' : 'creation')
            setError(null)
          }}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {mode === 'creation' ? 'Se connecter' : 'Créer votre accès'}
        </button>
      </p>
    </div>
  )
}
