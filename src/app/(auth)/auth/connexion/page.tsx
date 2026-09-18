import { Suspense } from 'react'

import { SignInForm } from './sign-in-form.tsx'

export const metadata = { title: 'Connexion' }

export default function ConnexionPage() {
  // `useSearchParams` impose une frontière de suspense au prérendu.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
      <SignInForm />
    </Suspense>
  )
}
