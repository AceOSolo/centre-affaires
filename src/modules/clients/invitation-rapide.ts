import { and, eq, isNull } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import { insertReturning } from '../../db/returning.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from './schema.ts'

/**
 * Invitation rapide d'un client (ADR 068) : depuis l'écran Comptes, l'équipe
 * saisit une adresse — et, si elle les connaît, un nom et une entreprise. Une
 * fiche prospect est créée avec l'accès de la personne, puis l'invitation
 * part comme depuis la fiche (`invitation.ts`, ADR 059).
 *
 * Un client est toujours rattaché à une entreprise : c'est ce qui borne ce
 * qu'il voit (ADR 019). Sans entreprise saisie, la fiche porte le nom de la
 * personne, à défaut son adresse — comme une fiche née d'une demande du site.
 */

export type QuickInviteInput = { email: string; fullName: string | null; company: string | null }

export type QuickInviteResult =
  | { ok: true; clientId: string; clientName: string }
  /** L'adresse a déjà un accès en cours : on ne crée pas de seconde fiche. */
  | { ok: false; clientId: string; clientName: string }

/** Nom de la fiche : l'entreprise, sinon la personne, sinon l'adresse. */
export function quickInviteClientName(input: QuickInviteInput): string {
  return (input.company?.trim() || input.fullName?.trim() || input.email.trim()).slice(0, 255)
}

export async function createInvitedClient(
  input: QuickInviteInput,
  options: { database?: Database; tenantId?: string } = {},
): Promise<QuickInviteResult> {
  const tenantId = options.tenantId ?? currentTenantId()
  const email = input.email.trim().toLowerCase()
  return withTenant(
    tenantId,
    async (tx) => {
      const [existing] = await tx
        .select({ clientId: clients.id, clientName: clients.name })
        .from(clientMembers)
        .innerJoin(clients, and(eq(clients.tenantId, clientMembers.tenantId), eq(clients.id, clientMembers.clientId)))
        .where(
          and(
            eq(clientMembers.tenantId, tenantId),
            eq(clientMembers.email, email),
            isNull(clientMembers.deletedAt),
            isNull(clients.deletedAt),
          ),
        )
        .limit(1)
      if (existing) return { ok: false, ...existing }

      const client = await insertReturning(tx, clients, {
        name: quickInviteClientName(input),
        email,
        status: 'prospect',
        origin: 'back_office',
        country: 'FR',
      })
      await tx.insert(clientMembers).values({
        clientId: client.id,
        email,
        fullName: input.fullName?.trim() || null,
      })
      return { ok: true, clientId: client.id, clientName: client.name }
    },
    options.database,
  )
}
