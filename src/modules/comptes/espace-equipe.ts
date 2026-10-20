import { and, eq, isNull, or } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { clientMembers } from '../clients/schema.ts'

/**
 * Le compte d'un membre de l'équipe a-t-il déjà un espace client dans ce
 * centre ? Un accès rattaché, ou une inscription faite à son adresse que la
 * première visite de `/compte` rattachera.
 *
 * Lecture seule, sans le verrou de `clientAccess` : la coque du back-office
 * l'appelle à chaque page pour choisir le libellé du lien.
 */
export async function staffHasClientSpace(tx: Transaction, user: AuthenticatedUser): Promise<boolean> {
  const [member] = await tx
    .select({ id: clientMembers.id })
    .from(clientMembers)
    .where(
      and(
        eq(clientMembers.tenantId, tenantContext.getStore() ?? DEFAULT_TENANT_ID),
        isNull(clientMembers.deletedAt),
        or(eq(clientMembers.authUserId, user.id), eq(clientMembers.email, user.email)),
      ),
    )
    .limit(1)
  return member !== undefined
}
