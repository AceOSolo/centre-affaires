'use client'

import { useEffect, useRef, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../../../components/ui/error-summary.tsx'
import { authClient } from '../../../../lib/auth/client.ts'
import { MOT_DE_PASSE_MIN, messageRefusAuth, serveurInjoignable } from '../../../../lib/auth/messages.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const errorClass = 'mt-1 text-sm text-destructive'
const linkClass =
  'inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-2 hover:underline'

/** Échec d'un envoi : des erreurs rattachées aux champs, ou au formulaire entier. */
type Echec = { message?: string; champs?: Record<string, string> }

/**
 * Choix du nouveau mot de passe, avec le jeton du lien reçu par courriel.
 *
 * Les sessions ouvertes avec l'ancien mot de passe sont fermées
 * (`revokeSessionsOnPasswordReset`, `lib/auth/server.ts`) ; aucune n'est
 * ouverte ici : la personne se connecte ensuite, avec le nouveau.
 */
export function NewPasswordForm({ token, equipe }: { token: string; equipe: boolean }) {
  const [envoi, setEnvoi] = useState(false)
  const [echec, setEchec] = useState<Echec | null>(null)
  const [change, setChange] = useState(false)
  // Chaque envoi remonte le résumé des erreurs : le même refus deux fois de
  // suite est de nouveau annoncé, et le focus y revient.
  const [tentative, setTentative] = useState(0)
  const resultat = useRef<HTMLDivElement>(null)

  const connexion = equipe ? '/auth/equipe' : '/auth/connexion'
  const nouveauLien = equipe ? '/auth/mot-de-passe-oublie?espace=equipe' : '/auth/mot-de-passe-oublie'

  // Le formulaire disparaît au succès : le focus va au message qui le remplace.
  useEffect(() => {
    if (change) resultat.current?.focus()
  }, [change])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEchec(null)
    setTentative((value) => value + 1)

    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    const confirmation = String(form.get('confirmation') ?? '')
    if (password !== confirmation) {
      setEchec({ champs: { confirmation: 'Les deux saisies ne correspondent pas.' } })
      return
    }

    setEnvoi(true)
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token })
      if (error) {
        const { message, champ } = messageRefusAuth(error, 'Le mot de passe n’a pas pu être changé.')
        setEchec(champ === 'password' ? { champs: { password: message } } : { message })
      } else {
        setChange(true)
      }
    } catch {
      setEchec({ message: serveurInjoignable })
    } finally {
      setEnvoi(false)
    }
  }

  const passwordError = echec?.champs?.password
  const confirmationError = echec?.champs?.confirmation

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">Nouveau mot de passe</h1>
        {!change && (
          <p className="mt-1 text-sm text-muted-foreground">
            Choisissez le mot de passe de votre compte. Les sessions ouvertes avec l’ancien seront
            fermées.
          </p>
        )}
      </div>

      {/* Hors du formulaire, qui disparaît : la région annoncée existe avant son contenu. */}
      <div
        ref={resultat}
        tabIndex={-1}
        aria-live="polite"
        className="rounded-sm empty:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {change && (
          <p className="rounded-sm border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            Votre mot de passe est changé. Connectez-vous avec le nouveau.
          </p>
        )}
      </div>

      {change ? (
        <Link
          href={connexion}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Se connecter
        </Link>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <ErrorSummary
            key={tentative}
            errors={echec?.champs}
            labels={{ password: 'Nouveau mot de passe', confirmation: 'Confirmation' }}
            message={echec?.message}
          />

          <div>
            <label className={labelClass} htmlFor="password">
              Nouveau mot de passe
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={MOT_DE_PASSE_MIN}
              autoComplete="new-password"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={passwordError ? 'password-error password-hint' : 'password-hint'}
              className={`${fieldClass} mt-1.5`}
            />
            <p id="password-hint" className="mt-1 text-xs text-muted-foreground">
              {MOT_DE_PASSE_MIN} caractères au minimum.
            </p>
            {passwordError && (
              <p id="password-error" role="alert" className={errorClass}>
                {passwordError}
              </p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="confirmation">
              Confirmation
            </label>
            <input
              id="confirmation"
              name="confirmation"
              type="password"
              required
              minLength={MOT_DE_PASSE_MIN}
              autoComplete="new-password"
              aria-invalid={confirmationError ? true : undefined}
              aria-describedby={confirmationError ? 'confirmation-error confirmation-hint' : 'confirmation-hint'}
              className={`${fieldClass} mt-1.5`}
            />
            <p id="confirmation-hint" className="mt-1 text-xs text-muted-foreground">
              Le même mot de passe, une seconde fois.
            </p>
            {confirmationError && (
              <p id="confirmation-error" role="alert" className={errorClass}>
                {confirmationError}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={envoi}
            className="mt-1 rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {envoi ? 'Enregistrement…' : 'Enregistrer le mot de passe'}
          </button>

          <Link href={nouveauLien} className={`${linkClass} self-start`}>
            Lien expiré ? En demander un nouveau
          </Link>
        </form>
      )}
    </div>
  )
}
