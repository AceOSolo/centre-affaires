'use client'

import { useTransition } from 'react'

import { useRouter } from 'next/navigation'

import { authClient } from '../../lib/auth/client.ts'

/**
 * Déconnexion. `refresh` après coup : la coque du back-office lit la session
 * côté serveur et doit être rejouée sans le cookie.
 *
 * `redirectTo` : la page de connexion à retrouver, celle de l'équipe depuis
 * le back-office (`/auth/equipe`), celle des clients sinon.
 */
export function SignOutButton({
  className,
  redirectTo = '/auth/connexion',
}: {
  className?: string
  redirectTo?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        await authClient.signOut()
        startTransition(() => {
          router.replace(redirectTo)
          router.refresh()
        })
      }}
      className={
        className ??
        'rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60'
      }
    >
      {pending ? 'Déconnexion…' : 'Se déconnecter'}
    </button>
  )
}
