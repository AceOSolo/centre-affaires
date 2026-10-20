'use server'

import { redirect } from 'next/navigation'

import { withTenant } from '../../db/index.ts'
import { requireStaff } from '../../lib/auth/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { staffHasClientSpace } from './espace-equipe.ts'
import { ensureSignupClient } from './inscription.ts'

/**
 * Espace client d'un membre de l'équipe, ouvert depuis le back-office.
 *
 * Un membre qui loue lui aussi, ou qui veut voir le portail tel que ses
 * clients le voient, y entre avec le même compte. S'il n'a encore aucune
 * entreprise, il reçoit sa propre fiche prospect, comme une inscription libre
 * (ADR 045) — mais seulement parce qu'il l'a demandée ici.
 */
export async function openStaffClientSpaceAction(): Promise<void> {
  const { user } = await requireStaff()
  await withTenant(currentTenantId(), async (tx) => {
    if (!(await staffHasClientSpace(tx, user))) await ensureSignupClient(tx, user, { forStaff: true })
  })
  redirect('/compte')
}
