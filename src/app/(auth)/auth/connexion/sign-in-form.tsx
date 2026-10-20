'use client'

import { useState, useTransition } from 'react'

import { useRouter, useSearchParams } from 'next/navigation'

import { authClient } from '../../../../lib/auth/client.ts'
import { safeRedirect } from '../../../../lib/redirection.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30'
const labelClass = 'block text-sm font-medium text-foreground'

type Mode = 'connexion' | 'creation'

/**
 * Plafond de tentatives atteint (`rateLimit`, `lib/auth/server.ts`) : Better
 * Auth répond 429 avec un message en anglais.
 */
const tropDeTentatives = 'Trop de tentatives depuis votre connexion. Patientez quelques minutes, puis réessayez.'

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
  const [error, setError] = useState<string | null>(null)
  // Inscription sur un serveur qui exige la vérification de l'adresse : aucune
  // session n'est ouverte, l'écran dit où est le message au lieu de rediriger.
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // `proxy.ts` ajoute le chemin demandé ; on y revient une fois connecté.
  // Sans chemin, l'équipe va au planning ; côté client, l'aiguillage choisit.
  const redirectTo = safeRedirect(searchParams.get('redirect')) ?? (equipe ? '/reservations' : '/auth/suite')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setConfirmation(null)

    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const name = String(form.get('name') ?? '').trim()
    const companyName = String(form.get('companyName') ?? '').trim()

    const repli =
      mode === 'creation'
        ? 'La création du compte a échoué.'
        : 'Adresse ou mot de passe incorrect.'

    // Le client d'authentification signale ses refus de deux façons selon le
    // cas : un `error` dans la réponse, ou une exception réseau. Les deux
    // doivent finir dans le `role="alert"` du formulaire, jamais dans
    // l'overlay d'erreur.
    try {
      if (mode === 'creation') {
        const { data, error: authError } = await authClient.signUp.email({
          email,
          password,
          name,
          companyName: companyName || undefined,
        })
        if (authError) {
          setError(authError.status === 429 ? tropDeTentatives : (authError.message ?? repli))
          return
        }
        // Sans session (adresse à confirmer), le jeton est nul : on ne
        // redirige pas vers une page qui renverrait à la connexion.
        if (!data?.token) {
          setConfirmation(
            `Un message de confirmation a été envoyé à ${email}. Confirmez-la puis connectez-vous.`,
          )
          setMode('connexion')
          return
        }
      } else {
        const { error: authError } = await authClient.signIn.email({ email, password })
        if (authError) {
          setError(
            authError.status === 429
              ? tropDeTentatives
              : authError.code === 'EMAIL_NOT_VERIFIED'
                ? 'Adresse non confirmée : ouvrez le message de confirmation reçu, puis réessayez.'
                : authError.code === 'BANNED_USER'
                  ? 'Ce compte est suspendu. Pour en savoir plus, contactez l’équipe du centre.'
                  : (authError.message ?? repli),
          )
          return
        }
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
            minLength={10}
            autoComplete={mode === 'creation' ? 'new-password' : 'current-password'}
            className={`${fieldClass} mt-1.5`}
          />
          {mode === 'creation' && (
            <p className="mt-1 text-xs text-muted-foreground">10 caractères au minimum.</p>
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
        {mode === 'creation'
          ? 'Vous avez déjà un compte ? '
          : equipe
            ? 'Vous venez d’être ajouté à l’équipe ? '
            : 'Première connexion ? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'creation' ? 'connexion' : 'creation')
            setError(null)
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
