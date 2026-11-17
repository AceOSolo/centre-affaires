import { Suspense } from 'react'

import { redirigerSiConnecte } from '../../deja-connecte-serveur.ts'
import { SignInForm } from './sign-in-form.tsx'

export const metadata = { title: 'Connexion' }

/**
 * Connexion de l'espace client. Déjà connecté, on n'y reste pas : la page
 * renvoie vers son espace, ou vers le chemin demandé (ADR 077).
 */
export default async function ConnexionPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const { redirect } = await searchParams
  await redirigerSiConnecte('client', redirect)
  // `useSearchParams` impose une frontière de suspense au prérendu.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
      <SignInForm />
    </Suspense>
  )
}
