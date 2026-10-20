'use client'

import { useEffect, useRef, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../../../components/ui/error-summary.tsx'
import { PreuveHumaine, preuveEnCours, reponsePreuve } from '../../../../components/ui/preuve-humaine.tsx'
import { authClient } from '../../../../lib/auth/client.ts'
import { messageRefusAuth, serveurInjoignable } from '../../../../lib/auth/messages.ts'
import { EN_TETE_PREUVE } from '../../../../lib/champs-anti-robot.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30'
const labelClass = 'block text-sm font-medium text-foreground'
const linkClass =
  'inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-2 hover:underline'

/**
 * Demande du lien de réinitialisation (`lib/auth/server.ts`,
 * `sendResetPassword`).
 *
 * La réponse est la même que l'adresse ait un compte ou non : dire « aucun
 * compte à cette adresse » renseignerait un visiteur sur la clientèle et
 * l'équipe. Comme l'inscription, la demande fait partir un courriel vers
 * l'adresse saisie : elle exige la preuve ALTCHA et un plafond par adresse IP
 * (ADR 047).
 */
export function ResetRequestForm({ equipe }: { equipe: boolean }) {
  const [envoi, setEnvoi] = useState(false)
  const [echec, setEchec] = useState<string | null>(null)
  const [envoyeA, setEnvoyeA] = useState<string | null>(null)
  // Chaque envoi remonte le résumé des erreurs : le même refus deux fois de
  // suite est de nouveau annoncé.
  const [tentative, setTentative] = useState(0)
  // Une réponse anti-robot ne sert qu'une fois : la case repart d'un défi neuf.
  const [essai, setEssai] = useState(0)
  const resultat = useRef<HTMLDivElement>(null)

  const connexion = equipe ? '/auth/equipe' : '/auth/connexion'

  // Le focus va au résultat : la personne au clavier ou au lecteur d'écran
  // l'apprend là où elle est.
  useEffect(() => {
    if (envoyeA) resultat.current?.focus()
  }, [envoyeA])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEchec(null)
    setEnvoyeA(null)
    setTentative((value) => value + 1)

    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    const preuve = reponsePreuve(event.currentTarget)
    if (!preuve) {
      setEchec(preuveEnCours)
      return
    }

    setEnvoi(true)
    setEssai((value) => value + 1)
    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        // Le lien du courriel passe par Better Auth, qui vérifie le jeton puis
        // mène à cette page avec `?token=` (ou `?error=INVALID_TOKEN`).
        redirectTo: equipe ? '/auth/nouveau-mot-de-passe?espace=equipe' : '/auth/nouveau-mot-de-passe',
        fetchOptions: { headers: { [EN_TETE_PREUVE]: preuve } },
      })
      if (error) {
        setEchec(messageRefusAuth(error, 'La demande n’a pas abouti. Réessayez dans quelques instants.').message)
      } else {
        setEnvoyeA(email)
      }
    } catch {
      setEchec(serveurInjoignable)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">Mot de passe oublié</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saisissez l’adresse de votre compte : nous vous envoyons un lien pour choisir un nouveau
          mot de passe.
        </p>
      </div>

      {/* La région annoncée existe avant son contenu. */}
      <div
        ref={resultat}
        tabIndex={-1}
        aria-live="polite"
        className="rounded-sm empty:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {envoyeA && (
          <div className="flex flex-col gap-2 rounded-sm border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            <p>
              Si un compte existe pour <strong className="font-medium">{envoyeA}</strong>, un message
              vient d’y être envoyé. Ouvrez le lien qu’il contient dans l’heure pour choisir un
              nouveau mot de passe.
            </p>
            <p className="text-muted-foreground">
              Rien reçu après quelques minutes ? Regardez dans les courriers indésirables, ou
              vérifiez l’adresse et refaites la demande.
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <ErrorSummary key={tentative} labels={{}} message={echec ?? undefined} />

        <div>
          <label className={labelClass} htmlFor="email">
            Adresse du compte
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

        <PreuveHumaine key={essai} />

        <button
          type="submit"
          disabled={envoi}
          className="mt-1 rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {envoi ? 'Envoi…' : 'Recevoir le lien'}
        </button>

        <Link href={connexion} className={`${linkClass} self-start`}>
          Retour à la connexion
        </Link>
      </form>
    </div>
  )
}
