import Link from 'next/link'

import { NewPasswordForm } from './new-password-form.tsx'

export const metadata = { title: 'Nouveau mot de passe' }

/**
 * Où mène le lien du courriel « Choisissez un nouveau mot de passe ». Better
 * Auth vérifie le jeton au passage (`/api/auth/reset-password/:token`) et
 * arrive ici avec `?token=`, ou `?error=INVALID_TOKEN` s'il a servi ou expiré.
 */
export default async function NouveauMotDePassePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; espace?: string }>
}) {
  const { token, error, espace } = await searchParams
  const equipe = espace === 'equipe'

  if (!token || error) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-primary">Lien plus valable</h1>
        <p className="text-sm text-muted-foreground">
          Ce lien a déjà servi ou a expiré : il ne vaut qu’une fois, et pendant une heure. Demandez-en
          un nouveau.
        </p>
        <Link
          href={equipe ? '/auth/mot-de-passe-oublie?espace=equipe' : '/auth/mot-de-passe-oublie'}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Demander un nouveau lien
        </Link>
      </div>
    )
  }

  return <NewPasswordForm token={token} equipe={equipe} />
}
