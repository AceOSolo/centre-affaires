import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import type { ContactInput } from './contacts-regles.ts'
import { clientContacts, clients, type ClientContact } from './schema.ts'

/**
 * Contacts des entreprises clientes (R07) : le carnet d'adresses du centre.
 *
 * Ce ne sont pas des accès à l'espace client (`comptes.ts`, ADR 015) : ajouter
 * un contact n'ouvre rien à personne, retirer un accès ne touche pas au
 * carnet.
 */

/** Contacts actifs d'une fiche : le principal d'abord, puis par nom. */
export async function listClientContacts(clientId: string): Promise<ClientContact[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(clientContacts)
      .where(and(eq(clientContacts.clientId, clientId), isNull(clientContacts.deletedAt)))
      .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.fullName), asc(clientContacts.id)),
  )
}

/** Un contact actif de cette fiche. Un contact retiré ne se modifie plus. */
export async function findClientContact(
  clientId: string,
  id: string,
): Promise<ClientContact | undefined> {
  const [contact] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(clientContacts)
      .where(
        and(
          eq(clientContacts.id, id),
          eq(clientContacts.clientId, clientId),
          isNull(clientContacts.deletedAt),
        ),
      )
      .limit(1),
  )
  return contact
}

/**
 * Fiche introuvable ou archivée : ses contacts restent lisibles en base, mais
 * on n'en ajoute, n'en modifie ni n'en retire plus.
 */
export class ContactClientUnavailableError extends Error {
  constructor() {
    super('Cette fiche client est archivée ou introuvable : ses contacts ne se modifient plus.')
    this.name = 'ContactClientUnavailableError'
  }
}

/**
 * Deux contacts désignés principaux au même instant, et l'index unique a
 * départagé. Le verrou de `lockClient` rend ce cas improbable ; il reste
 * traduit plutôt que de finir en erreur 500.
 */
export class PrimaryContactConflictError extends Error {
  constructor() {
    super('Un autre contact vient d’être désigné principal. Rechargez la fiche et recommencez.')
    this.name = 'PrimaryContactConflictError'
  }
}

/**
 * Verrouille la fiche pour la durée de la transaction, et vérifie qu'elle est
 * vivante.
 *
 * Le verrou sérialise les écritures de contacts d'une même entreprise : deux
 * personnes qui désignent chacune un principal passent l'une après l'autre, et
 * la seconde retire bien le rôle à celui de la première. `no key update` ne
 * gêne ni les clés étrangères qui visent la fiche, ni sa lecture.
 */
async function lockClient(tx: Transaction, clientId: string): Promise<void> {
  const [client] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
    .for('no key update')
  if (!client) throw new ContactClientUnavailableError()
}

/**
 * Retire le rôle de principal à celui qui le porte, pour le donner à un autre.
 * Au plus un principal actif par entreprise (`client_contacts_primary_key`) :
 * désigner le nouveau, c'est d'abord décharger l'ancien.
 */
async function releasePrimary(tx: Transaction, clientId: string, exceptId?: string) {
  await tx
    .update(clientContacts)
    .set({ isPrimary: false })
    .where(
      and(
        eq(clientContacts.clientId, clientId),
        eq(clientContacts.isPrimary, true),
        isNull(clientContacts.deletedAt),
        exceptId ? ne(clientContacts.id, exceptId) : undefined,
      ),
    )
}

function translate(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new PrimaryContactConflictError()
  throw error
}

export async function createClientContact(
  clientId: string,
  input: ContactInput,
): Promise<ClientContact> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      await lockClient(tx, clientId)
      if (input.isPrimary) await releasePrimary(tx, clientId)
      const [created] = await tx
        .insert(clientContacts)
        .values({ ...input, clientId })
        .returning()
      return created
    })
  } catch (error) {
    translate(error)
  }
}

/**
 * Modification d'un contact actif. Rend `undefined` quand il n'existe pas, a
 * été retiré entre-temps, ou relève d'une autre fiche.
 */
export async function updateClientContact(
  clientId: string,
  id: string,
  input: ContactInput,
): Promise<ClientContact | undefined> {
  const target = and(
    eq(clientContacts.id, id),
    eq(clientContacts.clientId, clientId),
    isNull(clientContacts.deletedAt),
  )
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      await lockClient(tx, clientId)
      // Vérifié avant de décharger l'ancien principal : un contact retiré
      // entre-temps ne doit pas laisser la fiche sans principal.
      const [existing] = await tx
        .select({ id: clientContacts.id })
        .from(clientContacts)
        .where(target)
      if (!existing) return undefined
      if (input.isPrimary) await releasePrimary(tx, clientId, id)
      const [updated] = await tx.update(clientContacts).set(input).where(target).returning()
      return updated
    })
  } catch (error) {
    translate(error)
  }
}

/**
 * Retrait logique (décision 6) : le contact sort de la fiche, la ligne reste.
 * Retiré, un contact principal libère la place. Rend `false` quand il n'y
 * avait rien à retirer.
 */
export async function removeClientContact(clientId: string, id: string): Promise<boolean> {
  const removed = await withTenant(currentTenantId(), async (tx) => {
    // Même verrou que l'écriture : un retrait ne croise pas une modification
    // qui vérifie l'existence du contact avant de lui donner le rôle principal.
    await lockClient(tx, clientId)
    return tx
      .update(clientContacts)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(clientContacts.id, id),
          eq(clientContacts.clientId, clientId),
          isNull(clientContacts.deletedAt),
        ),
      )
      .returning({ id: clientContacts.id })
  })
  return removed.length > 0
}
