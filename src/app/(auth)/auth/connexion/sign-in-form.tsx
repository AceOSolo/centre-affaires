'use client'

import { useState, useTransition } from 'react'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { ErrorSummary } from '../../../../components/ui/error-summary.tsx'
import { authClient } from '../../../../lib/auth/client.ts'
import { messageRefusAuth, serveurInjoignable, type MessageAuth } from '../../../../lib/auth/messages.ts'
import { safeRedirect } from '../../../../lib/redirection.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const errorClass = 'mt-1 text-sm text-destructive'

/** Échec d'un envoi : une erreur rattachée à un champ, ou au formulaire entier. */
type Echec = { message?: string; champs?: Record<string, string> }

const echecDe = ({ message, champ }: MessageAuth): Echec =>
  champ ? { champs: { [champ]: message } } : { message }

/**
 * `client` : la page des clients (`/auth/connexion`).
 * `equipe` : celle du back-office (`/auth/equipe`).
 */
export type Audience = 'client' | 'equipe'

/**
 * Formulaire de connexion des deux populations. Le compte Better Auth est le
 * même ; seules les pages diffèrent, pour que l'équipe et les clients ne
 * partagent pas un écran qui ne s'adresse vraiment à aucun des deux. Ce sont
 * `staff_members` et `client_members` qui donnent les droits (ADR 008, 015),
 * pas la page par laquelle on est entré.
 *
 * On ne crée plus de compte ici (ADR 068, qui revient sur l'ADR 045) : un
 * compte naît d'une invitation — équipe, espace client — ou d'une demande
 * déposée sur le site, par un lien reçu à son adresse pour choisir son mot
 * de passe. L'écran le dit à qui n'a pas encore de compte.
 */
export function SignInForm({ audience = 'client' }: { audience?: Audience }) {
  const equipe = audience === 'equipe'
  const router = useRouter()
  const searchParams = useSearchParams()
  const [echec, setEchec] = useState<Echec | null>(null)
  // Chaque envoi remonte le résumé des erreurs : le même refus deux fois de
  // suite est de nouveau annoncé, et le focus y revient.
  const [tentative, setTentative] = useState(0)
  // L'appel au service d'authentification lui-même ; `pending` ne couvre
  // que la navigation qui suit.
  const [envoi, setEnvoi] = useState(false)
  const [pending, startTransition] = useTransition()
  const occupe = envoi || pending

  // `proxy.ts` ajoute le chemin demandé ; on y revient une fois connecté.
  // Sans chemin, l'équipe va au planning ; côté client, l'aiguillage choisit.
  const redirectTo = safeRedirect(searchParams.get('redirect')) ?? (equipe ? '/aujourdhui' : '/auth/suite')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEchec(null)
    setTentative((value) => value + 1)

    const form = new FormData(event.currentTarget)
    setEnvoi(true)
    const connecte = await envoyer(form)
    if (!connecte) {
      setEnvoi(false)
      return
    }

    // `refresh` avant `replace` : la coque du back-office lit la session côté
    // serveur, elle doit être rejouée avec le cookie fraîchement posé.
    startTransition(() => {
      router.replace(redirectTo)
      router.refresh()
    })
  }

  /** Appelle le service d'authentification ; vrai quand une session est ouverte. */
  async function envoyer(form: FormData): Promise<boolean> {
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')

    // Le client d'authentification signale ses refus de deux façons selon le
    // cas : un `error` dans la réponse, ou une exception réseau. Les deux
    // doivent finir dans le résumé d'erreurs du formulaire, jamais dans
    // l'overlay d'erreur ; et en français (`lib/auth/messages.ts`).
    try {
      const { error: authError } = await authClient.signIn.email({ email, password })
      if (authError) {
        setEchec(echecDe(messageRefusAuth(authError, 'La connexion a échoué.')))
        return false
      }
      return true
    } catch {
      setEchec({ message: serveurInjoignable })
      return false
    }
  }

  const emailError = echec?.champs?.email
  const passwordError = echec?.champs?.password

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">{equipe ? 'Connexion équipe' : 'Connexion'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {equipe ? 'Back-office du centre, réservé à l’équipe.' : 'Espace client.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <ErrorSummary
          key={tentative}
          errors={echec?.champs}
          labels={{ email: 'Adresse professionnelle', password: 'Mot de passe' }}
          message={echec?.message}
        />

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
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? 'email-error' : undefined}
            className={`${fieldClass} mt-1.5`}
          />
          {emailError && (
            <p id="email-error" role="alert" className={errorClass}>
              {emailError}
            </p>
          )}
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
            autoComplete="current-password"
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? 'password-error' : undefined}
            className={`${fieldClass} mt-1.5`}
          />
          {passwordError && (
            <p id="password-error" role="alert" className={errorClass}>
              {passwordError}
            </p>
          )}
          <Link
            href={equipe ? '/auth/mot-de-passe-oublie?espace=equipe' : '/auth/mot-de-passe-oublie'}
            className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            Mot de passe oublié ?
          </Link>
        </div>

        <button
          type="submit"
          disabled={occupe}
          className="mt-1 rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {occupe ? 'Un instant…' : 'Se connecter'}
        </button>
      </form>

      {equipe ? (
        <p className="text-sm text-muted-foreground">
          Vous venez d’être ajouté à l’équipe ? Ouvrez le lien reçu par courriel pour choisir votre
          mot de passe. Lien expiré : demandez qu’on vous renvoie l’invitation.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Pas encore de compte ?</p>
          <p>
            Faites une demande depuis le site : vous recevrez par courriel un lien pour créer votre
            espace et y suivre votre demande.
          </p>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center self-start font-medium text-primary underline-offset-2 hover:underline"
          >
            Faire une demande
          </Link>
          <p>Déjà client du centre ? Demandez votre accès à l’accueil : il vous envoie le lien.</p>
        </div>
      )}
    </div>
  )
}
