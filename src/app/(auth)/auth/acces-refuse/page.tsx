import Link from 'next/link'

import { clientAccess } from '../../../../modules/clients/session.ts'
import { SignOutButton } from '../../sign-out-button.tsx'

export const metadata = { title: 'Accès refusé' }

/**
 * Compte valide, mais sans droit sur l'espace demandé : ni membre de l'équipe,
 * ni rattaché à une entreprise cliente — ou client qui tente le back-office.
 *
 * Le message reste vague sur la raison : dire « cette adresse n'est pas
 * inscrite » renseignerait un visiteur sur l'équipe et sur la clientèle.
 */
export default async function AccesRefusePage() {
  // Un client arrivé sur le back-office par un vieux lien retrouve son espace.
  const client = await clientAccess()

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-primary">Accès refusé</h1>
      <p className="text-sm text-muted-foreground">
        Votre compte est bien connecté, mais il n&rsquo;a pas accès à cet espace. Si vous pensez
        qu&rsquo;il s&rsquo;agit d&rsquo;une erreur, contactez l&rsquo;équipe du centre pour
        qu&rsquo;elle vous inscrive avec cette adresse.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {client.status === 'client' && (
          <Link
            href="/compte"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Aller à mon espace client
          </Link>
        )}
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
