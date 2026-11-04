import { and, desc, eq, lt, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { withTenant } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { openSecret, sealSecret } from '../../lib/chiffrement.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import type { CrmAccessStore, CrmCredential, CrmInboundSettings } from './acces.ts'
import type { CrmConnectorId } from './connecteurs.ts'
import { readEnabledFlows, type CrmFlowId } from './flux.ts'
import { crmConnections, crmExchanges, type CrmExchangeDirection } from './schema.ts'

/**
 * Lectures et écritures de la connexion au CRM (ADR 065).
 *
 * Tout se lit et s'écrit pour le centre courant (`currentTenantId()`), sauf
 * la recherche d'un jeton : c'est elle qui trouve le centre d'un appel.
 */

/** Durée de conservation du journal des échanges, en jours. */
export const CRM_EXCHANGE_RETENTION_DAYS = 90

/* ------------------------------------------------------------------------ */
/* Accès des routes du CRM                                                  */
/* ------------------------------------------------------------------------ */

const inboundColumns = {
  tenantId: crmConnections.tenantId,
  connector: crmConnections.connector,
  tokenHash: crmConnections.inboundTokenHash,
  enabledFlows: crmConnections.enabledFlows,
}

type InboundRow = { tenantId: string; connector: CrmConnectorId; tokenHash: string | null; enabledFlows: unknown }

const toInbound = (row: InboundRow): CrmInboundSettings => ({
  tenantId: row.tenantId,
  connector: row.connector,
  tokenHash: row.tokenHash,
  enabledFlows: readEnabledFlows(row.enabledFlows),
})

/** Les réglages lus en base, pour `resolveCrmAccess` (`acces.ts`). */
export const crmAccessStore: CrmAccessStore = {
  async byTokenHash(hash) {
    // La seule lecture sans filtre de centre du module, et elle est voulue :
    // le centre n'est pas connu avant elle, c'est le jeton qui le désigne.
    // L'empreinte est unique sur toute la base (`crm_connections_inbound_token_key`).
    const [row] = await withTenant(currentTenantId(), (tx) =>
      tx.select(inboundColumns).from(crmConnections).where(eq(crmConnections.inboundTokenHash, hash)).limit(1),
    )
    return row ? toInbound(row) : undefined
  },
  async forTenant(tenantId) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select(inboundColumns).from(crmConnections).where(eq(crmConnections.tenantId, tenantId)).limit(1),
    )
    return row ? toInbound(row) : undefined
  },
}

/* ------------------------------------------------------------------------ */
/* Journal des échanges                                                     */
/* ------------------------------------------------------------------------ */

export type CrmExchangeEntry = {
  connector: CrmConnectorId
  direction: CrmExchangeDirection
  flow: CrmFlowId | null
  operation: string
  statusCode: number | null
  ok: boolean
  message: string | null
  credential: CrmCredential | null
  durationMs: number
}

const clip = (text: string | null, max: number) =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * Inscrit un échange au journal du centre, et purge ce qui a dépassé
 * `CRM_EXCHANGE_RETENTION_DAYS`. Ne lève jamais : un journal en panne ne doit
 * pas faire échouer l'appel du CRM, qui a déjà eu lieu.
 */
export async function recordCrmExchange(tenantId: string, entry: CrmExchangeEntry): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(crmExchanges).values({
        tenantId,
        connector: entry.connector,
        direction: entry.direction,
        flow: entry.flow,
        operation: clip(entry.operation, 120)!,
        statusCode: entry.statusCode,
        ok: entry.ok,
        message: clip(entry.message, 500),
        credential: entry.credential,
        durationMs: Math.max(0, Math.round(entry.durationMs)),
      })
      await tx
        .delete(crmExchanges)
        .where(
          and(
            eq(crmExchanges.tenantId, tenantId),
            lt(
              crmExchanges.createdAt,
              sql`${maintenant()} - interval ${sql.raw(String(CRM_EXCHANGE_RETENTION_DAYS))} day`,
            ),
          ),
        )
    })
  } catch (error) {
    console.error('Journal des échanges avec le CRM : écriture impossible.', error)
  }
}

/** Les derniers échanges du centre, les plus récents d'abord. */
export async function listCrmExchanges(limit = 30) {
  const tenantId = currentTenantId()
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: crmExchanges.id,
        createdAt: crmExchanges.createdAt,
        connector: crmExchanges.connector,
        direction: crmExchanges.direction,
        flow: crmExchanges.flow,
        operation: crmExchanges.operation,
        statusCode: crmExchanges.statusCode,
        ok: crmExchanges.ok,
        message: crmExchanges.message,
        credential: crmExchanges.credential,
        durationMs: crmExchanges.durationMs,
      })
      .from(crmExchanges)
      .where(eq(crmExchanges.tenantId, tenantId))
      .orderBy(desc(crmExchanges.createdAt), desc(crmExchanges.id))
      .limit(limit),
  )
}

export type CrmExchangeRow = Awaited<ReturnType<typeof listCrmExchanges>>[number]

/** Dernier appel reçu du CRM, pour dire si le connecteur tourne. */
export async function lastInboundExchange(): Promise<CrmExchangeRow | undefined> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: crmExchanges.id,
        createdAt: crmExchanges.createdAt,
        connector: crmExchanges.connector,
        direction: crmExchanges.direction,
        flow: crmExchanges.flow,
        operation: crmExchanges.operation,
        statusCode: crmExchanges.statusCode,
        ok: crmExchanges.ok,
        message: crmExchanges.message,
        credential: crmExchanges.credential,
        durationMs: crmExchanges.durationMs,
      })
      .from(crmExchanges)
      .where(and(eq(crmExchanges.tenantId, tenantId), eq(crmExchanges.direction, 'inbound')))
      .orderBy(desc(crmExchanges.createdAt), desc(crmExchanges.id))
      .limit(1),
  )
  return row
}

/* ------------------------------------------------------------------------ */
/* L'écran                                                                  */
/* ------------------------------------------------------------------------ */

/** Ce que l'écran montre du réglage. Ni l'empreinte du jeton, ni la clé chiffrée. */
export type CrmConnectionView = {
  configured: boolean
  connector: CrmConnectorId
  baseUrl: string | null
  hasToken: boolean
  tokenSetAt: Date | null
  tokenSetBy: string | null
  hasKey: boolean
  keySetAt: Date | null
  enabledFlows: CrmFlowId[]
  /** Premier jour des consommations transmises (ADR 066), jour du centre. */
  consumptionsFrom: string | null
  updatedAt: Date | null
}

export async function crmConnectionView(): Promise<CrmConnectionView> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        connector: crmConnections.connector,
        baseUrl: crmConnections.baseUrl,
        hasToken: sql<number>`${crmConnections.inboundTokenHash} is not null`,
        tokenSetAt: crmConnections.inboundTokenSetAt,
        tokenSetByName: staffMembers.fullName,
        tokenSetByEmail: staffMembers.email,
        hasKey: sql<number>`${crmConnections.outboundKeySealed} is not null`,
        keySetAt: crmConnections.outboundKeySetAt,
        enabledFlows: crmConnections.enabledFlows,
        consumptionsFrom: crmConnections.consumptionsFrom,
        updatedAt: crmConnections.updatedAt,
      })
      .from(crmConnections)
      .leftJoin(
        staffMembers,
        and(eq(staffMembers.id, crmConnections.inboundTokenSetBy), eq(staffMembers.tenantId, tenantId)),
      )
      .where(eq(crmConnections.tenantId, tenantId))
      .limit(1),
  )
  if (!row) {
    return {
      configured: false,
      connector: 'dolibarr',
      baseUrl: null,
      hasToken: false,
      tokenSetAt: null,
      tokenSetBy: null,
      hasKey: false,
      keySetAt: null,
      enabledFlows: readEnabledFlows(undefined),
      consumptionsFrom: null,
      updatedAt: null,
    }
  }
  return {
    configured: true,
    connector: row.connector,
    baseUrl: row.baseUrl,
    hasToken: Boolean(Number(row.hasToken)),
    tokenSetAt: row.tokenSetAt,
    // Un membre anonymisé n'a plus ni nom ni adresse (ADR 040).
    tokenSetBy: row.tokenSetByName ?? row.tokenSetByEmail ?? null,
    hasKey: Boolean(Number(row.hasKey)),
    keySetAt: row.keySetAt,
    enabledFlows: readEnabledFlows(row.enabledFlows),
    consumptionsFrom: row.consumptionsFrom,
    updatedAt: row.updatedAt,
  }
}

/**
 * Crée le réglage du centre ou le modifie, colonne par colonne : ce qui n'est
 * pas donné reste tel quel. Une ligne par centre (`crm_connections_tenant_key`).
 */
async function upsertConnection(
  staffMemberId: string,
  changes: Partial<Omit<typeof crmConnections.$inferInsert, 'id' | 'tenantId' | 'updatedBy'>>,
): Promise<void> {
  const tenantId = currentTenantId()
  await withTenant(tenantId, (tx) =>
    tx
      .insert(crmConnections)
      .values({ tenantId, ...changes, updatedBy: staffMemberId })
      .onDuplicateKeyUpdate({ set: { ...changes, updatedBy: staffMemberId } }),
  )
}

/**
 * CRM, adresse et, si elle est donnée, clé d'appel. `key` : `undefined` garde
 * la clé enregistrée, `null` l'efface. Changer de CRM retire le jeton d'écran
 * et la clé : ils étaient ceux de l'ancien.
 */
export async function saveCrmSettings(
  input: { connector: CrmConnectorId; baseUrl: string | null; key?: string | null },
  staffMemberId: string,
): Promise<void> {
  const current = await crmConnectionView()
  const switching = current.configured && current.connector !== input.connector
  const keyChanges =
    input.key === undefined
      ? switching
        ? { outboundKeySealed: null, outboundKeySetAt: null }
        : {}
      : input.key === null
        ? { outboundKeySealed: null, outboundKeySetAt: null }
        : { outboundKeySealed: sealSecret(input.key), outboundKeySetAt: new Date() }
  await upsertConnection(staffMemberId, {
    connector: input.connector,
    baseUrl: input.baseUrl,
    ...keyChanges,
    ...(switching ? { inboundTokenHash: null, inboundTokenSetAt: null, inboundTokenSetBy: null } : {}),
  })
}

/** Pose l'empreinte d'un jeton neuf : l'ancien, et celui du serveur, cessent aussitôt. */
export async function setCrmToken(tokenHash: string, staffMemberId: string): Promise<void> {
  await upsertConnection(staffMemberId, {
    inboundTokenHash: tokenHash,
    inboundTokenSetAt: new Date(),
    inboundTokenSetBy: staffMemberId,
  })
}

/** Retire le jeton d'écran : le jeton du serveur, s'il est posé, vaut de nouveau. */
export async function removeCrmToken(staffMemberId: string): Promise<void> {
  await upsertConnection(staffMemberId, {
    inboundTokenHash: null,
    inboundTokenSetAt: null,
    inboundTokenSetBy: null,
  })
}

/**
 * Flux activés et, si elle est donnée, date de départ des consommations
 * (ADR 066). `consumptionsFrom` : `undefined` la garde telle quelle.
 */
export async function saveCrmFlows(
  flows: readonly CrmFlowId[],
  staffMemberId: string,
  consumptionsFrom?: string | null,
): Promise<void> {
  await upsertConnection(staffMemberId, {
    enabledFlows: [...flows],
    ...(consumptionsFrom === undefined ? {} : { consumptionsFrom }),
  })
}

/** Adresse et clé en clair, pour le test de connexion. Jamais pour l'affichage. */
export async function crmOutboundCredentials(): Promise<
  { connector: CrmConnectorId; baseUrl: string | null; key: string | null; unreadable: boolean } | undefined
> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        connector: crmConnections.connector,
        baseUrl: crmConnections.baseUrl,
        sealed: crmConnections.outboundKeySealed,
      })
      .from(crmConnections)
      .where(eq(crmConnections.tenantId, tenantId))
      .limit(1),
  )
  if (!row) return undefined
  if (!row.sealed) return { connector: row.connector, baseUrl: row.baseUrl, key: null, unreadable: false }
  try {
    return { connector: row.connector, baseUrl: row.baseUrl, key: openSecret(row.sealed), unreadable: false }
  } catch {
    // Clé du serveur changée ou absente (`SECRETS_ENCRYPTION_KEY`) : à ressaisir.
    return { connector: row.connector, baseUrl: row.baseUrl, key: null, unreadable: true }
  }
}
