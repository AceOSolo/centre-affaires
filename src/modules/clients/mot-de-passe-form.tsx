'use client'

import { useRef, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { authClient } from '../../lib/auth/client.ts'
import { MOT_DE_PASSE_MIN, messageRefusAuth, serveurInjoignable } from '../../lib/auth/messages.ts'

const fieldClass =
  'mt-1.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-base outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

type Champ = 'currentPassword' | 'newPassword' | 'confirmation'

const labels: Record<Champ, string> = {
  currentPassword: 'Mot de passe actuel',
  newPassword: 'Nouveau mot de passe',
  confirmation: 'Confirmation',
}

type Echec = { message?: string; champs?: Partial<Record<Champ, string>> }

/**
 * Changer son mot de passe depuis « Mon compte » (ADR 077), par le client
 * d'authentification (Better Auth, `change-password`) : l'ancien est vérifié,
 * les sessions ouvertes ailleurs sont fermées, celle-ci reste ouverte.
 *
 * Mot de passe actuel oublié : se déconnecter, puis « Mot de passe oublié ? »
 * sur la page de connexion (connecté, cette page renvoie à l'espace).
 */
export function PasswordForm() {
  const [envoi, setEnvoi] = useState(false)
  const [echec, setEchec] = useState<Echec | null>(null)
  const [change, setChange] = useState(false)
  const [tentative, setTentative] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEchec(null)
    setChange(false)
    setTentative((value) => value + 1)

    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get('currentPassword') ?? '')
    const newPassword = String(form.get('newPassword') ?? '')
    const confirmation = String(form.get('confirmation') ?? '')
    const champs: Partial<Record<Champ, string>> = {}
    if (!currentPassword) champs.currentPassword = 'Saisissez votre mot de passe actuel.'
    if (newPassword.length < MOT_DE_PASSE_MIN) {
      champs.newPassword = `${MOT_DE_PASSE_MIN} caractères au minimum.`
    }
    if (newPassword !== confirmation) champs.confirmation = 'Les deux saisies ne correspondent pas.'
    if (Object.keys(champs).length > 0) {
      setEchec({ champs })
      return
    }

    setEnvoi(true)
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })
      if (error) {
        // Better Auth rend `INVALID_PASSWORD` quand l'ancien mot de passe ne correspond pas.
        if (error.code === 'INVALID_PASSWORD') {
          setEchec({ champs: { currentPassword: 'Mot de passe actuel incorrect.' } })
        } else {
          const { message, champ } = messageRefusAuth(error, 'Le mot de passe n’a pas pu être changé.')
          setEchec(champ === 'password' ? { champs: { newPassword: message } } : { message })
        }
      } else {
        setChange(true)
        formRef.current?.reset()
      }
    } catch {
      setEchec({ message: serveurInjoignable })
    } finally {
      setEnvoi(false)
    }
  }

  const erreur = (champ: Champ) => echec?.champs?.[champ]

  const field = (champ: Champ, autoComplete: string, hint?: string) => {
    const error = erreur(champ)
    const describedBy = [error ? `${champ}-error` : null, hint ? `${champ}-hint` : null].filter(Boolean).join(' ')
    return (
      <div>
        <label className={labelClass} htmlFor={champ}>
          {labels[champ]}{' '}
          <span aria-hidden="true" className="text-primary">
            *
          </span>
        </label>
        <input
          id={champ}
          name={champ}
          type="password"
          required
          aria-required="true"
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={fieldClass}
        />
        {hint && (
          <p id={`${champ}-hint`} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {error && (
          <p id={`${champ}-error`} role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted-foreground">
        Les champs marqués <span aria-hidden="true">*</span>
        <span className="sr-only">d’un astérisque</span> sont obligatoires.
      </p>
      <ErrorSummary key={tentative} errors={echec?.champs} labels={labels} message={echec?.message} />
      {field('currentPassword', 'current-password')}
      {field('newPassword', 'new-password', `${MOT_DE_PASSE_MIN} caractères au minimum.`)}
      {field('confirmation', 'new-password', 'Le même mot de passe, une seconde fois.')}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={envoi}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {envoi ? 'Enregistrement…' : 'Changer mon mot de passe'}
        </button>
        <p role="status" className="text-sm text-primary">
          {change ? 'Mot de passe changé. Vos autres appareils devront se reconnecter.' : ''}
        </p>
      </div>
    </form>
  )
}
