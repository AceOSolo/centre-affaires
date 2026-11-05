import Link from 'next/link'

import { INVITATION_JOURS } from '../../../../lib/auth/messages.ts'
import { NewPasswordForm } from './new-password-form.tsx'

export const metadata = { title: 'Nouveau mot de passe' }

/**
 * Où mène le lien du courriel « Choisissez un nouveau mot de passe ». Better
 * Auth vérifie le jeton au passage (`/api/auth/reset-password/:token`) et
 * arrive ici avec `?token=`, ou `?error=INVALID_TOKEN` s'il a servi ou expiré.
 *
 * `?invitation=1` : le lien d'une invitation (ADR 059, ADR 068), valable
 * plusieurs jours, où la personne choisit son premier mot de passe — à
 * l'espace client, ou au back-office avec `espace=equipe`.
 */
export default async function NouveauMotDePassePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; espace?: string; invitation?: string }>
}) {
  const { token, error, espace, invitation } = await searchParams
  const equipe = espace === 'equipe'
  const invite = invitation === '1'

  if (!token || error) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-primary">Lien plus valable</h1>
        <p className="text-sm text-muted-foreground">
          {invite
            ? `Ce lien d’invitation a déjà servi ou a expiré : il ne vaut qu’une fois, et pendant ${INVITATION_JOURS} jours. ${
                equipe
                  ? 'Demandez à la personne qui vous a ajouté à l’équipe de vous renvoyer l’invitation'
                  : 'Demandez au centre de vous renvoyer l’invitation'
              }, ou recevez un nouveau lien ici.`
            : 'Ce lien a déjà servi ou a expiré : il ne vaut qu’une fois, et pendant une heure. Demandez-en un nouveau.'}
        </p>
        <Link
          href={equipe ? '/auth/mot-de-passe-oublie?espace=equipe' : '/auth/mot-de-passe-oublie'}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Demander un nouveau lien
        </Link>
        {invite && (
          <Link
            href={equipe ? '/auth/equipe' : '/auth/connexion'}
            className="inline-flex min-h-11 items-center self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            J’ai déjà choisi mon mot de passe : me connecter
          </Link>
        )}
      </div>
    )
  }

  return <NewPasswordForm token={token} equipe={equipe} invitation={invite} />
}
