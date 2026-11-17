import Link from 'next/link'

import { staffAccess } from '../../../../lib/auth/staff.ts'
import { clientAccess } from '../../../../modules/clients/session.ts'
import { SignOutButton } from '../../sign-out-button.tsx'

export const metadata = { title: 'Accès refusé' }

/**
 * Compte valide, mais sans droit sur l'espace demandé : ni membre de l'équipe,
 * ni rattaché à une entreprise cliente — ou client qui tente le back-office,
 * ou membre de l'équipe sur la page de connexion des clients (ADR 083).
 *
 * Le message reste vague sur la raison : dire « cette adresse n'est pas
 * inscrite » renseignerait un visiteur sur l'équipe et sur la clientèle.
 */
export default async function AccesRefusePage() {
  // Chacun retrouve son propre espace : un client arrivé sur le back-office
  // par un vieux lien, un membre de l'équipe sur la connexion des clients.
  const staff = await staffAccess()
  const client = staff.status === 'membre' ? null : await clientAccess()

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-primary">Accès refusé</h1>
      <p className="text-sm text-muted-foreground">
        Votre compte est bien connecté, mais il n&rsquo;a pas accès à cet espace. Si vous pensez
        qu&rsquo;il s&rsquo;agit d&rsquo;une erreur, contactez l&rsquo;équipe du centre pour
        qu&rsquo;elle vous inscrive avec cette adresse.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {staff.status === 'membre' && (
          <Link
            href="/aujourdhui"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Aller au back-office
          </Link>
        )}
        {client?.status === 'client' && (
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
