import { ResetRequestForm } from './reset-request-form.tsx'

export const metadata = { title: 'Mot de passe oublié' }

/**
 * Demande d'un lien pour choisir un nouveau mot de passe.
 *
 * Une seule page pour l'équipe et les clients : le compte est le même.
 * `?espace=equipe` (lien de `/auth/equipe`) ne sert qu'à ramener vers la bonne
 * page de connexion.
 */
export default async function MotDePasseOubliePage({
  searchParams,
}: {
  searchParams: Promise<{ espace?: string }>
}) {
  const { espace } = await searchParams
  return <ResetRequestForm equipe={espace === 'equipe'} />
}
