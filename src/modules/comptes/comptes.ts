import { and, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { tenantContext } from '../../db/contexte.ts'
import { DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import type { Transaction } from '../../db/index.ts'
import { staffMembers, type StaffRole } from '../../db/staff.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { authSessions, authUsers } from '../../lib/auth/schema.ts'
import { clientMembers, clients, type ClientOrigin } from '../clients/schema.ts'
import { escapeLike } from '../clients/recherche.ts'
import { accountState, type AccountState, type BanInput } from './regles.ts'
import { accountBans, type AccountBan } from './schema.ts'

/**
 * Comptes du site, gérés par l'équipe (ADR 045) : la liste, le bannissement,
 * sa levée, le rattachement à une entreprise.
 *
 * Comme `lib/auth/membre.ts`, ce module ne connaît ni Next ni la session : il
 * reçoit une transaction déjà placée dans un centre (`withTenant()`) et
 * s'éprouve contre une vraie base (`comptes.db.test.ts`).
 *
 * Les comptes (`auth_users`) n'ont pas de centre. Un centre voit ceux qui
 * relèvent de lui — équipe, entreprise cliente, bannissement — et ceux qui ne
 * relèvent encore d'aucun : inscrits dont l'adresse n'est pas confirmée.
 */

const currentTenant = () => tenantContext.getStore() ?? DEFAULT_TENANT_ID

/** Le compte relève du centre courant, ou d'aucun centre. */
const visibleInTenant = () => sql`(
  exists (select 1 from staff_members s where s.auth_user_id = ${authUsers.id} and s.tenant_id = ${currentTenant()})
  or exists (select 1 from client_members m where m.auth_user_id = ${authUsers.id} and m.tenant_id = ${currentTenant()})
  or exists (select 1 from account_bans b where b.auth_user_id = ${authUsers.id} and b.tenant_id = ${currentTenant()})
  or (
    not exists (select 1 from staff_members s where s.auth_user_id = ${authUsers.id})
    and not exists (select 1 from client_members m where m.auth_user_id = ${authUsers.id})
  )
)`

/** Bannissement en vigueur : pas levé, sans terme ou avant son terme. */
const activeBanCondition = () =>
  and(
    eq(accountBans.tenantId, currentTenant()),
    isNull(accountBans.liftedAt),
    or(isNull(accountBans.bannedUntil), gt(accountBans.bannedUntil, maintenant())),
  )

/**
 * Bannissement en vigueur du compte dans ce centre, le plus récent. C'est ce
 * que lit la connexion (`lib/auth/server.ts`) pour refuser d'ouvrir une
 * session.
 */
export async function activeBan(tx: Transaction, authUserId: string): Promise<AccountBan | undefined> {
  const [ban] = await tx
    .select()
    .from(accountBans)
    .where(and(activeBanCondition(), eq(accountBans.authUserId, authUserId)))
    .orderBy(desc(accountBans.createdAt))
    .limit(1)
  return ban
}

export type AccountCompany = { clientId: string; clientName: string; origin: ClientOrigin }

export type AccountRow = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  /** Rôle dans l'équipe du centre, s'il en fait partie. */
  staffRole: StaffRole | null
  companies: AccountCompany[]
  state: AccountState
}

export type AccountStateFilter = 'actif' | 'banni'

/** Plafond de la liste : au-delà, la recherche s'impose. */
export const ACCOUNT_LIST_LIMIT = 200

/**
 * Comptes du centre, les plus récents d'abord, avec ce qui les y relie.
 *
 * Trois lectures et un assemblage en code plutôt qu'une jointure : un compte a
 * plusieurs entreprises et plusieurs bannissements, une jointure multiplierait
 * les lignes.
 */
export async function listAccounts(
  tx: Transaction,
  filters: { search?: string; state?: AccountStateFilter; ids?: readonly string[] } = {},
): Promise<{ rows: AccountRow[]; truncated: boolean }> {
  const query = filters.search?.trim()
  const pattern = query ? `%${escapeLike(query.toLowerCase())}%` : null
  const users = await tx
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      emailVerified: authUsers.emailVerified,
      createdAt: authUsers.createdAt,
    })
    .from(authUsers)
    .where(
      and(
        visibleInTenant(),
        pattern ? or(like(sql`lower(${authUsers.name})`, pattern), like(authUsers.email, pattern)) : undefined,
        filters.ids ? inArray(authUsers.id, [...filters.ids]) : undefined,
      ),
    )
    .orderBy(desc(authUsers.createdAt))
    // Le filtre d'état se fait après lecture des bannissements : on lit un de plus
    // que le plafond pour savoir s'il est atteint.
    .limit(filters.state ? 10_000 : ACCOUNT_LIST_LIMIT + 1)

  const rows = await withLinks(tx, users)
  const filtered = filters.state ? rows.filter((row) => row.state.kind === filters.state) : rows
  return {
    rows: filtered.slice(0, ACCOUNT_LIST_LIMIT),
    truncated: filtered.length > ACCOUNT_LIST_LIMIT,
  }
}

async function withLinks(
  tx: Transaction,
  users: Omit<AccountRow, 'staffRole' | 'companies' | 'state'>[],
): Promise<AccountRow[]> {
  if (users.length === 0) return []
  const ids = users.map((user) => user.id)

  const [staff, companies, bans] = await Promise.all([
    tx
      .select({ authUserId: staffMembers.authUserId, role: staffMembers.role })
      .from(staffMembers)
      .where(
        and(
          eq(staffMembers.tenantId, currentTenant()),
          inArray(staffMembers.authUserId, ids),
          isNull(staffMembers.deletedAt),
        ),
      ),
    tx
      .select({
        authUserId: clientMembers.authUserId,
        clientId: clients.id,
        clientName: clients.name,
        origin: clients.origin,
      })
      .from(clientMembers)
      .innerJoin(
        clients,
        and(eq(clients.tenantId, clientMembers.tenantId), eq(clients.id, clientMembers.clientId)),
      )
      .where(
        and(
          eq(clientMembers.tenantId, currentTenant()),
          inArray(clientMembers.authUserId, ids),
          isNull(clientMembers.deletedAt),
          isNull(clients.deletedAt),
        ),
      )
      .orderBy(clients.name),
    tx
      .select({
        authUserId: accountBans.authUserId,
        bannedUntil: accountBans.bannedUntil,
        liftedAt: accountBans.liftedAt,
      })
      .from(accountBans)
      .where(and(eq(accountBans.tenantId, currentTenant()), inArray(accountBans.authUserId, ids))),
  ])

  return users.map((user) => ({
    ...user,
    staffRole: staff.find((row) => row.authUserId === user.id)?.role ?? null,
    companies: companies
      .filter((row) => row.authUserId === user.id)
      .map(({ clientId, clientName, origin }) => ({ clientId, clientName, origin })),
    state: accountState(bans.filter((ban) => ban.authUserId === user.id)),
  }))
}

export type BanHistoryEntry = AccountBan & {
  bannedByName: string | null
  liftedByName: string | null
}

export type AccountDetail = AccountRow & { bans: BanHistoryEntry[] }

/** Un compte du centre et l'historique de ses bannissements, les plus récents d'abord. */
export async function findAccount(tx: Transaction, id: string): Promise<AccountDetail | undefined> {
  const { rows } = await listAccounts(tx, { ids: [id] })
  const [account] = rows
  if (!account) return undefined

  const bans = await tx
    .select()
    .from(accountBans)
    .where(and(eq(accountBans.tenantId, currentTenant()), eq(accountBans.authUserId, id)))
    .orderBy(desc(accountBans.createdAt))
  const authorIds = [
    ...new Set(bans.flatMap((ban) => [ban.bannedBy, ban.liftedBy]).filter((value): value is string => !!value)),
  ]
  const authors = authorIds.length
    ? await tx
        .select({ id: staffMembers.id, fullName: staffMembers.fullName, email: staffMembers.email })
        .from(staffMembers)
        .where(and(eq(staffMembers.tenantId, currentTenant()), inArray(staffMembers.id, authorIds)))
    : []
  const nameOf = (staffId: string | null) => {
    const author = authors.find((row) => row.id === staffId)
    return author ? (author.fullName ?? author.email) : null
  }

  return {
    ...account,
    bans: bans.map((ban) => ({
      ...ban,
      bannedByName: nameOf(ban.bannedBy),
      liftedByName: nameOf(ban.liftedBy),
    })),
  }
}

/** Ce qui fait refuser un bannissement. */
export type BanRefusal = 'soi-meme' | 'equipe' | 'deja-banni' | 'introuvable'

export const banRefusalMessages: Record<BanRefusal, string> = {
  'soi-meme': 'Vous ne pouvez pas bannir votre propre compte.',
  equipe:
    'Ce compte est celui d’un membre de l’équipe : retirez-le d’abord de l’équipe, depuis l’écran Équipe.',
  'deja-banni': 'Ce compte est déjà banni : levez le bannissement en cours avant d’en poser un autre.',
  introuvable: 'Ce compte n’existe pas, ou ne relève pas de ce centre.',
}

export type BanOutcome = { authUserId: string; refusal: BanRefusal | null }

/**
 * Bannit des comptes, un par un sous la même règle : ni soi-même, ni un
 * membre de l'équipe — la porte de l'équipe est l'écran Équipe, et un
 * exploitant banni par erreur ne pourrait plus rien réparer —, ni un compte
 * déjà banni.
 *
 * Les sessions ouvertes du compte sont supprimées dans la même transaction :
 * le bannissement prend effet à la requête suivante, pas à la fin de la
 * session. Les suivantes sont refusées à la connexion (`server.ts`).
 */
export async function banAccounts(
  tx: Transaction,
  input: { actor: { memberId: string; authUserId: string }; authUserIds: readonly string[]; ban: BanInput },
): Promise<BanOutcome[]> {
  const outcomes: BanOutcome[] = []
  for (const authUserId of new Set(input.authUserIds)) {
    outcomes.push({ authUserId, refusal: await banOne(tx, authUserId, input.actor, input.ban) })
  }
  return outcomes
}

async function banOne(
  tx: Transaction,
  authUserId: string,
  actor: { memberId: string; authUserId: string },
  ban: BanInput,
): Promise<BanRefusal | null> {
  if (authUserId === actor.authUserId) return 'soi-meme'

  // Verrou du compte : deux bannissements simultanés du même compte se
  // suivent, le second voit le premier.
  const [user] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(and(eq(authUsers.id, authUserId), visibleInTenant()))
    .for('update')
  if (!user) return 'introuvable'

  const [staff] = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(
      and(
        eq(staffMembers.tenantId, currentTenant()),
        eq(staffMembers.authUserId, authUserId),
        isNull(staffMembers.deletedAt),
      ),
    )
    .limit(1)
  if (staff) return 'equipe'

  if (await activeBan(tx, authUserId)) return 'deja-banni'

  await tx.insert(accountBans).values({
    authUserId,
    reason: ban.reason,
    bannedUntil: ban.bannedUntil,
    bannedBy: actor.memberId,
  })
  await tx.delete(authSessions).where(eq(authSessions.userId, authUserId))
  return null
}

/**
 * Lève les bannissements en vigueur des comptes. Les bannissements échus sont
 * laissés tels quels : leur terme dit déjà comment ils ont fini.
 *
 * Rend les comptes effectivement réactivés.
 */
export async function liftBans(
  tx: Transaction,
  input: { actorMemberId: string; authUserIds: readonly string[] },
): Promise<string[]> {
  if (input.authUserIds.length === 0) return []
  const where = and(activeBanCondition(), inArray(accountBans.authUserId, [...input.authUserIds]))
  const lifted = await tx
    .select({ id: accountBans.id, authUserId: accountBans.authUserId })
    .from(accountBans)
    .where(where)
    .for('update')
  if (lifted.length === 0) return []
  await tx
    .update(accountBans)
    .set({ liftedAt: maintenant(), liftedBy: input.actorMemberId })
    .where(inArray(accountBans.id, lifted.map((row) => row.id)))
  return [...new Set(lifted.map((row) => row.authUserId))]
}

export type AttachRefusal = 'introuvable' | 'client-introuvable' | 'deja-rattache'

export const attachRefusalMessages: Record<AttachRefusal, string> = {
  introuvable: 'Ce compte n’existe pas, ou ne relève pas de ce centre.',
  'client-introuvable': 'Cette entreprise n’existe pas ou a été archivée.',
  'deja-rattache': 'Ce compte a déjà accès à l’espace de cette entreprise.',
}

/**
 * Donne au compte l'accès à l'espace d'une entreprise existante : une
 * personne de plus sur la fiche (`client_members`), déjà rattachée au compte,
 * sous son adresse.
 *
 * La fiche créée à l'inscription reste : elle porte peut-être déjà des
 * demandes. L'équipe l'archive depuis la fiche client si elle n'a plus lieu
 * d'être.
 */
export async function attachAccountToClient(
  tx: Transaction,
  input: { authUserId: string; clientId: string },
): Promise<{ ok: true; clientName: string } | { ok: false; refusal: AttachRefusal }> {
  const [user] = await tx
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(and(eq(authUsers.id, input.authUserId), visibleInTenant()))
    .limit(1)
  if (!user) return { ok: false, refusal: 'introuvable' }

  const [client] = await tx
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(
      and(eq(clients.tenantId, currentTenant()), eq(clients.id, input.clientId), isNull(clients.deletedAt)),
    )
    .limit(1)
  if (!client) return { ok: false, refusal: 'client-introuvable' }

  const [linked] = await tx
    .select({ id: clientMembers.id })
    .from(clientMembers)
    .where(
      and(
        eq(clientMembers.tenantId, currentTenant()),
        eq(clientMembers.clientId, client.id),
        eq(clientMembers.authUserId, user.id),
        isNull(clientMembers.deletedAt),
      ),
    )
    .limit(1)
  if (linked) return { ok: false, refusal: 'deja-rattache' }

  try {
    await tx.insert(clientMembers).values({
      clientId: client.id,
      email: user.email.trim().toLowerCase(),
      authUserId: user.id,
      fullName: user.name || null,
    })
  } catch (error) {
    // L'adresse est déjà inscrite sur la fiche, sans être rattachée : la
    // personne la réclamera à sa prochaine connexion (`resolveClientAccounts`).
    if (dbErrorCode(error) === DB_UNIQUE_VIOLATION) return { ok: false, refusal: 'deja-rattache' }
    throw error
  }
  return { ok: true, clientName: client.name }
}
