import Link from 'next/link'

import { SignOutButton } from '../../sign-out-button.tsx'

export const metadata = { title: 'Accès refusé' }

/**
 * Compte valide, mais qui ne fait pas partie de l'équipe du centre.
 *
 * Le message reste vague sur la raison : dire « cette adresse n'est pas dans
 * l'équipe » renseignerait un visiteur sur la composition de l'équipe.
 */
export default function AccesRefusePage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-secondary">Accès refusé</h1>
      <p className="text-sm text-muted-foreground">
        Votre compte est bien connecté, mais il n&rsquo;a pas accès à l&rsquo;espace de gestion du
        centre. Si vous pensez qu&rsquo;il s&rsquo;agit d&rsquo;une erreur, contactez
        l&rsquo;équipe du centre pour qu&rsquo;elle vous inscrive.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <SignOutButton />
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Retour au site
        </Link>
      </div>
    </div>
  )
}
