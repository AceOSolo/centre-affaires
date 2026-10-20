import { Suspense } from 'react'

import { SignInForm } from '../connexion/sign-in-form.tsx'

export const metadata = { title: 'Connexion équipe' }

/**
 * Connexion du back-office, distincte de celle des clients (`/auth/connexion`).
 * C'est là que renvoient `proxy.ts` et `requireStaff()` quand personne n'est
 * connecté sur un écran de l'équipe.
 */
export default function ConnexionEquipePage() {
  // `useSearchParams` impose une frontière de suspense au prérendu.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
      <SignInForm audience="equipe" />
    </Suspense>
  )
}
