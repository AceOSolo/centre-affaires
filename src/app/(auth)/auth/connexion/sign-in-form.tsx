'use client'

import { useState, useTransition } from 'react'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { ErrorSummary } from '../../../../components/ui/error-summary.tsx'
import { PreuveHumaine, preuveEnCours, reponsePreuve } from '../../../../components/ui/preuve-humaine.tsx'
import { authClient } from '../../../../lib/auth/client.ts'
import {
  MOT_DE_PASSE_MIN,
  messageRefusAuth,
  serveurInjoignable,
  type MessageAuth,
} from '../../../../lib/auth/messages.ts'
import { EN_TETE_PREUVE } from '../../../../lib/champs-anti-robot.ts'
import { safeRedirect } from '../../../../lib/redirection.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const errorClass = 'mt-1 text-sm text-destructive'

type Mode = 'connexion' | 'creation'

/** Échec d'un envoi : une erreur rattachée à un champ, ou au formulaire entier. */
type Echec = { message?: string; champs?: Record<string, string> }

const echecDe = ({ message, champ }: MessageAuth): Echec =>
  champ ? { champs: { [champ]: message } } : { message }

/**
 * `client` : la page des clients (`/auth/connexion`), avec l'inscription libre.
 * `equipe` : celle du back-office (`/auth/equipe`) ; pas d'entreprise à saisir,
 * et la première connexion d'un membre inscrit dans l'écran Équipe y crée son
 * mot de passe.
 */
export type Audience = 'client' | 'equipe'

/**
 * Formulaire de connexion des deux populations. Le compte Better Auth est le
 * même ; seules les pages diffèrent, pour que l'équipe et les clients ne
 * partagent pas un écran qui ne s'adresse vraiment à aucun des deux. Ce sont
 * `staff_members` et `client_members` qui donnent les droits (ADR 008, 015),
 * pas la page par laquelle on est entré.
 *
 * Créer un compte est libre (ADR 045). Une adresse inscrite par le centre
 * retrouve son entreprise (`client_members`, ADR 015) ou le back-office
 * (`staff_members`, ADR 008) ; toute autre reçoit, une fois confirmée, sa
 * propre fiche client « inscrite en ligne ». L'écran ne dit pas laquelle des
 * deux s'applique : il ne doit pas révéler quelles adresses sont inscrites.
 */
export function SignInForm({ audience = 'client' }: { audience?: Audience }) {
  const equipe = audience === 'equipe'
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<Mode>('connexion')
  const [echec, setEchec] = useState<Echec | null>(null)
  // Chaque envoi remonte le résumé des erreurs : le même refus deux fois de
  // suite est de nouveau annoncé, et le focus y revient.
  const [tentative, setTentative] = useState(0)
  // L'appel au service d'authentification lui-même ; `pending` ne couvre
  // que la navigation qui suit.
  const [envoi, setEnvoi] = useState(false)
  // Inscription sur un serveur qui exige la vérification de l'adresse : aucune
  // session n'est ouverte, l'écran dit où est le message au lieu de rediriger.
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Une réponse anti-robot ne sert qu'une fois : après chaque essai
  // d'inscription, la case repart d'un défi neuf.
  const [essai, setEssai] = useState(0)
  const occupe = envoi || pending

  // `proxy.ts` ajoute le chemin demandé ; on y revient une fois connecté.
  // Sans chemin, l'équipe va au planning ; côté client, l'aiguillage choisit.
  const redirectTo = safeRedirect(searchParams.get('redirect')) ?? (equipe ? '/aujourdhui' : '/auth/suite')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEchec(null)
    setConfirmation(null)
    setTentative((value) => value + 1)

    const form = new FormData(event.currentTarget)
    const preuve = reponsePreuve(event.currentTarget)
    if (mode === 'creation' && !preuve) {
      setEchec({ message: preuveEnCours })
      return
    }

    setEnvoi(true)
    const connecte = await envoyer(form, preuve)
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
  async function envoyer(form: FormData, preuve: string): Promise<boolean> {
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const name = String(form.get('name') ?? '').trim()
    const companyName = String(form.get('companyName') ?? '').trim()

    const repli = mode === 'creation' ? 'La création du compte a échoué.' : 'La connexion a échoué.'

    // Le client d'authentification signale ses refus de deux façons selon le
    // cas : un `error` dans la réponse, ou une exception réseau. Les deux
    // doivent finir dans le résumé d'erreurs du formulaire, jamais dans
    // l'overlay d'erreur ; et en français (`lib/auth/messages.ts`).
    try {
      if (mode === 'creation') {
        setEssai((value) => value + 1)
        const { data, error: authError } = await authClient.signUp.email({
          email,
          password,
          name,
          companyName: companyName || undefined,
          // Le lien du message de confirmation ouvre la session puis mène ici :
          // à l'espace attendu, pas à l'accueil du site.
          callbackURL: redirectTo,
          fetchOptions: { headers: { [EN_TETE_PREUVE]: preuve } },
        })
        if (authError) {
          setEchec(echecDe(messageRefusAuth(authError, repli)))
          return false
        }
        // Sans session (adresse à confirmer), le jeton est nul : on ne
        // redirige pas vers une page qui renverrait à la connexion.
        if (!data?.token) {
          setConfirmation(
            `Un message de confirmation a été envoyé à ${email}. Confirmez-la puis connectez-vous.`,
          )
          setMode('connexion')
          return false
        }
        return true
      }

      const { error: authError } = await authClient.signIn.email({ email, password })
      if (authError) {
        setEchec(echecDe(messageRefusAuth(authError, repli)))
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
        <h1 className="text-xl font-semibold text-primary">
          {equipe
            ? mode === 'creation'
              ? 'Première connexion équipe'
              : 'Connexion équipe'
            : mode === 'creation'
              ? 'Créer votre accès'
              : 'Connexion'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {equipe
            ? mode === 'creation'
              ? 'Utilisez l’adresse sous laquelle l’exploitant vous a inscrit dans l’écran Équipe, et choisissez votre mot de passe.'
              : 'Back-office du centre, réservé à l’équipe.'
            : mode === 'creation'
              ? 'Si le centre vous a déjà inscrit, utilisez cette adresse : vous retrouverez l’espace de votre entreprise.'
              : 'Espace client.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {confirmation && (
          <p
            role="status"
            className="rounded-sm border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground"
          >
            {confirmation}
          </p>
        )}

        <ErrorSummary
          key={tentative}
          errors={echec?.champs}
          labels={{ email: 'Adresse professionnelle', password: 'Mot de passe' }}
          message={echec?.message}
        />

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

        {mode === 'creation' && !equipe && (
          <div>
            <label className={labelClass} htmlFor="companyName">
              Entreprise <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="companyName"
              name="companyName"
              maxLength={255}
              autoComplete="organization"
              aria-describedby="companyName-hint"
              className={`${fieldClass} mt-1.5`}
            />
            <p id="companyName-hint" className="mt-1 text-xs text-muted-foreground">
              Laissez vide si vous louez en votre nom propre.
            </p>
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
            minLength={MOT_DE_PASSE_MIN}
            autoComplete={mode === 'creation' ? 'new-password' : 'current-password'}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={
              [passwordError && 'password-error', mode === 'creation' && 'password-hint']
                .filter(Boolean)
                .join(' ') || undefined
            }
            className={`${fieldClass} mt-1.5`}
          />
          {mode === 'creation' && (
            <p id="password-hint" className="mt-1 text-xs text-muted-foreground">
              {MOT_DE_PASSE_MIN} caractères au minimum.
            </p>
          )}
          {passwordError && (
            <p id="password-error" role="alert" className={errorClass}>
              {passwordError}
            </p>
          )}
          {mode === 'connexion' && (
            <Link
              href={equipe ? '/auth/mot-de-passe-oublie?espace=equipe' : '/auth/mot-de-passe-oublie'}
              className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              Mot de passe oublié ?
            </Link>
          )}
        </div>

        {mode === 'creation' && <PreuveHumaine key={essai} />}

        <button
          type="submit"
          disabled={occupe}
          className="mt-1 rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {occupe
            ? 'Un instant…'
            : mode === 'creation'
              ? 'Créer le compte'
              : 'Se connecter'}
        </button>
      </form>

      <p className="text-sm text-muted-foreground">
        {mode === 'creation'
          ? 'Vous avez déjà un compte ? '
          : equipe
            ? 'Vous venez d’être ajouté à l’équipe ? '
            : 'Première connexion ? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'creation' ? 'connexion' : 'creation')
            setEchec(null)
            setConfirmation(null)
          }}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {mode === 'creation' ? 'Se connecter' : equipe ? 'Choisir votre mot de passe' : 'Créer votre accès'}
        </button>
      </p>
    </div>
  )
}
