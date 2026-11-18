import { Suspense } from 'react'

import { redirigerSiConnecte } from '../../deja-connecte-serveur.ts'
import { SignInForm } from '../connexion/sign-in-form.tsx'

export const metadata = { title: 'Connexion équipe' }

/**
 * Connexion du back-office, distincte de celle des clients (`/auth/connexion`).
 * C'est là que renvoient `proxy.ts` et `requireStaff()` quand personne n'est
 * connecté sur un écran de l'équipe. Déjà connecté, on n'y reste pas : la
 * page renvoie vers le back-office, ou vers le chemin demandé (ADR 077).
 */
export default async function ConnexionEquipePage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>
}) {
  const { redirect } = await searchParams
  await redirigerSiConnecte('equipe', redirect)
  // `useSearchParams` impose une frontière de suspense au prérendu.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
      <SignInForm audience="equipe" />
    </Suspense>
  )
}
