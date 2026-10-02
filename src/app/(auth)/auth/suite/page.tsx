import { redirect } from 'next/navigation'

import { staffAccess } from '../../../../lib/auth/staff.ts'
import { clientAccess } from '../../../../modules/clients/session.ts'

/**
 * Aiguillage après connexion, quand aucune page n'était demandée : l'équipe
 * vers le planning, les clients vers leur espace (ADR 015).
 *
 * L'équipe passe en premier. Une personne à la fois membre de l'équipe et
 * inscrite pour une entreprise — un gérant de centre domicilié chez lui — a
 * plus souvent affaire au back-office ; son espace client reste à `/compte`.
 */
export default async function SuitePage() {
  const staff = await staffAccess()
  if (staff.status === 'anonyme') redirect('/auth/connexion')
  if (staff.status === 'membre') redirect('/reservations')

  const client = await clientAccess()
  redirect(client.status === 'client' ? '/compte' : '/auth/acces-refuse')
}
