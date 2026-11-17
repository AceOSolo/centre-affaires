import { redirigerSiConnecte } from '../../deja-connecte-serveur.ts'
import { ResetRequestForm } from './reset-request-form.tsx'

export const metadata = { title: 'Mot de passe oublié' }

/**
 * Demande d'un lien pour choisir un nouveau mot de passe.
 *
 * Une seule page pour l'équipe et les clients : le compte est le même.
 * `?espace=equipe` (lien de `/auth/equipe`) ne sert qu'à ramener vers la bonne
 * page de connexion.
 *
 * Déjà connecté, on n'y reste pas (ADR 077) : la page renvoie vers son
 * espace. Un client y change son mot de passe dans « Mon compte », en donnant
 * l'ancien ; qui l'a oublié se déconnecte d'abord.
 */
export default async function MotDePasseOubliePage({
  searchParams,
}: {
  searchParams: Promise<{ espace?: string }>
}) {
  const { espace } = await searchParams
  await redirigerSiConnecte(espace === 'equipe' ? 'equipe' : 'client')
  return <ResetRequestForm equipe={espace === 'equipe'} />
}
