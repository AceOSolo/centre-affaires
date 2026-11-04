import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'

import {
  DB_COMMITMENT_LOCKED,
  DB_EXCLUSION_VIOLATION,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
  dbSignalMessage,
} from '../../db/errors.ts'
import type { Transaction } from '../../db/index.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import type { CrmConnectorId } from '../crm/connecteurs.ts'
import { crmLinks } from '../crm/schema-liens.ts'
import { resources } from '../ressources/schema.ts'
import {
  crmContractStatusWords,
  decideContractMatch,
  type ContractCandidate,
  type ReceivedContract,
} from './contrats-crm.ts'
import { contracts } from './schema.ts'

/**
 * Contrats reçus du CRM, en base (ADR 066). Une transaction par envoi ; le
 * contrat écrit, la base en tient l'occupation dans la même transaction
 * (`contracts_after_insert`, `_after_update`) : un chevauchement refuse
 * l'envoi entier, jamais une écriture à moitié faite.
 *
 * Le prix, la TVA, la périodicité et l'engagement d'un contrat engagé ne
 * changent sur le site que par avenant (`CA004`) ; la copie d'un contrat du
 * CRM les suit pourtant, sous la variable de session `@app_crm_sync`, que
 * seul ce module pose (`40-contrats.sql`).
 */

export type CrmContractOutcome =
  | {
      result: 'cree' | 'rapproche' | 'modifie' | 'inchange' | 'retire' | 'ignore'
      contractId: string | null
      reference: string | null
      message: string
    }
  | { result: 'refuse'; status: 400 | 404 | 409; message: string }

async function contractCandidates(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  where: ReturnType<typeof and>,
): Promise<ContractCandidate[]> {
  const rows = await tx
    .select({
      contractId: contracts.id,
      reference: contracts.reference,
      clientId: contracts.clientId,
      deletedAt: contracts.deletedAt,
      linkedTo: crmLinks.externalId,
    })
    .from(contracts)
    .leftJoin(
      crmLinks,
      and(
        eq(crmLinks.tenantId, contracts.tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'contract'),
        eq(crmLinks.localId, contracts.id),
        isNull(crmLinks.removedAt),
      ),
    )
    .where(and(eq(contracts.tenantId, tenantId), where))
  return rows.map((row) => ({
    contractId: row.contractId,
    reference: row.reference,
    clientId: row.clientId,
    archived: row.deletedAt !== null,
    linkedTo: row.linkedTo,
  }))
}

const comparedColumns = {
  clientId: contracts.clientId,
  reference: contracts.reference,
  contractType: contracts.contractType,
  status: contracts.status,
  startsOn: contracts.startsOn,
  endsOn: contracts.endsOn,
  terminatedOn: contracts.terminatedOn,
  terminationReason: contracts.terminationReason,
  resourceId: contracts.resourceId,
  amountCents: contracts.amountCents,
  billingPeriod: contracts.billingPeriod,
  vatRateBp: contracts.vatRateBp,
  currency: contracts.currency,
  commitmentMonths: contracts.commitmentMonths,
  noticeDays: contracts.noticeDays,
  tacitRenewal: contracts.tacitRenewal,
  renewalMonths: contracts.renewalMonths,
}

/**
 * Reçoit un contrat : le rapproche d'un contrat du site, ou en crée un, et
 * reprend ce que le CRM en tient ; l'occupation suit. Rejouable.
 */
export async function receiveCrmContract(connector: CrmConnectorId, input: ReceivedContract): Promise<CrmContractOutcome> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, async (tx) => {
      // Seul ce chemin écrit une copie du CRM : la variable ne survit pas à la
      // transaction, ni à une erreur.
      await tx.execute(sql`set @app_crm_sync = 'on'`)
      try {
        return await applyContract(tx, tenantId, connector, input)
      } finally {
        await tx.execute(sql`set @app_crm_sync = null`).catch(() => {})
      }
    })
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === DB_EXCLUSION_VIOLATION) {
      return {
        result: 'refuse',
        status: 409,
        message: `La ressource est déjà occupée sur cette période (réservation ou autre contrat) : ${dbSignalMessage(error) ?? 'chevauchement'}. Libérer la ressource sur le site, ou corriger le contrat dans le CRM.`,
      }
    }
    if (code === DB_COMMITMENT_LOCKED) {
      return { result: 'refuse', status: 409, message: dbSignalMessage(error) ?? 'Contrat engagé : changement refusé.' }
    }
    if (code === DB_UNIQUE_VIOLATION) {
      return {
        result: 'refuse',
        status: 409,
        message: 'Référence déjà portée par un autre contrat du site, ou contrat reçu par un autre envoi au même instant : rejouer l’envoi, ou changer la référence.',
      }
    }
    if (code?.startsWith('CA')) {
      return { result: 'refuse', status: 409, message: dbSignalMessage(error) ?? 'Refusé par une règle du site.' }
    }
    throw error
  }
}

async function applyContract(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  input: ReceivedContract,
): Promise<CrmContractOutcome> {
  const [link] = await tx
    .select({ id: crmLinks.id, localId: crmLinks.localId, removedAt: crmLinks.removedAt })
    .from(crmLinks)
    .where(
      and(
        eq(crmLinks.tenantId, tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'contract'),
        eq(crmLinks.externalId, input.crmId),
      ),
    )
    .for('update')
  const liveLink = link && !link.removedAt ? link : undefined
  const linked = liveLink
    ? ((await contractCandidates(tx, tenantId, connector, eq(contracts.id, liveLink.localId)))[0] ?? null)
    : null

  if (input.removed) {
    const decision = decideContractMatch(input, { linked, explicit: null, byReference: null, clientId: null })
    if (decision.kind !== 'remove') {
      return {
        result: 'ignore',
        contractId: decision.kind === 'ignore' ? decision.contractId : null,
        reference: linked?.reference ?? null,
        message: decision.kind === 'ignore' || decision.kind === 'refuse' ? decision.message : '',
      }
    }
    // Archivé (décision 6) : la base annule son occupation (« Contrat archivé »).
    await tx
      .update(contracts)
      .set({ deletedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(contracts.tenantId, tenantId), eq(contracts.id, decision.contractId)))
    await tx
      .update(crmLinks)
      .set({ removedAt: sql`CURRENT_TIMESTAMP(3)`, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, liveLink!.id)))
    return {
      result: 'retire',
      contractId: decision.contractId,
      reference: linked!.reference,
      message: 'Contrat supprimé dans le CRM : archivé sur le site, sa ressource est libérée.',
    }
  }

  // Le tiers du contrat doit être connu du site.
  const clientLink = alias(crmLinks, 'client_link')
  const [owner] = await tx
    .select({ clientId: clients.id, deletedAt: clients.deletedAt })
    .from(clientLink)
    .innerJoin(clients, and(eq(clients.tenantId, clientLink.tenantId), eq(clients.id, clientLink.localId)))
    .where(
      and(
        eq(clientLink.tenantId, tenantId),
        eq(clientLink.connector, connector),
        eq(clientLink.entity, 'client'),
        eq(clientLink.externalId, input.thirdPartyCrmId),
        isNull(clientLink.removedAt),
      ),
    )
  if (!owner) {
    return {
      result: 'refuse',
      status: 409,
      message: `Tiers ${input.thirdPartyCrmId} inconnu du site : l’envoyer d’abord (POST /api/dolibarr/tiers), puis renvoyer le contrat.`,
    }
  }
  if (owner.deletedAt) {
    return { result: 'refuse', status: 409, message: `La fiche ${owner.clientId} du tiers est archivée sur le site : son contrat n’est pas repris.` }
  }

  let resourceId: string | null = null
  if (input.resourceCode) {
    const [resource] = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.code, input.resourceCode), isNull(resources.deletedAt)))
      .limit(1)
    if (!resource) {
      return {
        result: 'refuse',
        status: 400,
        message: `Ressource « ${input.resourceCode} » inconnue du site : son code se lit à l’écran Ressources.`,
      }
    }
    resourceId = resource.id
  }

  const explicit = !linked && input.contractId
    ? ((await contractCandidates(tx, tenantId, connector, eq(contracts.id, input.contractId)))[0] ?? 'missing')
    : null
  const byReference = !linked && !input.contractId
    ? ((await contractCandidates(
        tx,
        tenantId,
        connector,
        and(eq(contracts.reference, input.fields.reference), isNull(contracts.deletedAt)),
      ))[0] ?? null)
    : null
  const decision = decideContractMatch(input, { linked, explicit, byReference, clientId: owner.clientId })
  if (decision.kind === 'refuse') return { result: 'refuse', status: decision.status, message: decision.message }
  if (decision.kind === 'ignore') {
    return { result: 'ignore', contractId: decision.contractId, reference: linked?.reference ?? null, message: decision.message }
  }
  if (decision.kind === 'remove') throw new Error('Inatteignable : un contrat reçu n’est retiré que supprimé.')

  // Le terme vient du CRM : pas de reconduction tacite sur le site.
  const values = {
    ...input.fields,
    clientId: owner.clientId,
    resourceId,
    tacitRenewal: false,
    renewalMonths: null,
  }

  let contractId: string
  let changed = true
  if (decision.kind === 'create') {
    contractId = uuidv7()
    await tx.insert(contracts).values({ id: contractId, tenantId, ...values })
  } else {
    contractId = decision.contractId
    const [current] = await tx
      .select(comparedColumns)
      .from(contracts)
      .where(and(eq(contracts.tenantId, tenantId), eq(contracts.id, contractId)))
      .for('update')
    changed = (Object.keys(values) as (keyof typeof values)[]).some(
      (key) => (current?.[key as keyof typeof current] ?? null) !== (values[key] ?? null),
    )
    if (changed) {
      await tx
        .update(contracts)
        .set(values)
        .where(and(eq(contracts.tenantId, tenantId), eq(contracts.id, contractId)))
    }
  }

  if (liveLink) {
    await tx
      .update(crmLinks)
      .set({ externalRef: input.fields.reference, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, liveLink.id)))
  } else if (link) {
    await tx
      .update(crmLinks)
      .set({ localId: contractId, externalRef: input.fields.reference, removedAt: null, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, link.id)))
  } else {
    await tx.insert(crmLinks).values({
      tenantId,
      connector,
      entity: 'contract',
      localId: contractId,
      externalId: input.crmId,
      externalRef: input.fields.reference,
    })
  }

  const reference = input.fields.reference
  if (decision.kind === 'create') return { result: 'cree', contractId, reference, message: `Contrat ${reference} créé.` }
  if (decision.how !== 'link') {
    return { result: 'rapproche', contractId, reference, message: `Contrat rapproché du contrat ${reference} du site.` }
  }
  return changed
    ? { result: 'modifie', contractId, reference, message: 'Contrat mis à jour.' }
    : { result: 'inchange', contractId, reference, message: 'Rien n’a changé.' }
}

/* ------------------------------------------------------------------------ */
/* Ce que le CRM lit                                                        */
/* ------------------------------------------------------------------------ */

export type CrmContractListItem = {
  contratId: string
  dolibarrId: string | null
  reference: string
  tiers: { clientId: string; dolibarrId: string | null; nom: string }
  type: string
  statut: string
  debut: string
  fin: string | null
  resilieLe: string | null
  ressource: string | null
}

/**
 * Les contrats vivants du centre et leur objet dans le CRM
 * (`GET /api/dolibarr/contrats`) : pour rapprocher, une fois, ceux que le
 * site tenait avant le CRM. Par identifiant croissant, `apres` pour la suite.
 */
export async function listContractsForCrm(
  connector: CrmConnectorId,
  filter: { linked?: boolean; limit: number; after?: string },
): Promise<CrmContractListItem[]> {
  const tenantId = currentTenantId()
  const contractLink = alias(crmLinks, 'contract_link')
  const clientLink = alias(crmLinks, 'client_link')
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: contracts.id,
        reference: contracts.reference,
        contractType: contracts.contractType,
        status: contracts.status,
        startsOn: contracts.startsOn,
        endsOn: contracts.endsOn,
        terminatedOn: contracts.terminatedOn,
        clientId: contracts.clientId,
        clientName: clients.name,
        resourceCode: resources.code,
        crmId: contractLink.externalId,
        clientCrmId: clientLink.externalId,
      })
      .from(contracts)
      .innerJoin(clients, and(eq(clients.tenantId, contracts.tenantId), eq(clients.id, contracts.clientId)))
      .leftJoin(resources, and(eq(resources.tenantId, contracts.tenantId), eq(resources.id, contracts.resourceId)))
      .leftJoin(
        contractLink,
        and(
          eq(contractLink.tenantId, contracts.tenantId),
          eq(contractLink.connector, connector),
          eq(contractLink.entity, 'contract'),
          eq(contractLink.localId, contracts.id),
          isNull(contractLink.removedAt),
        ),
      )
      .leftJoin(
        clientLink,
        and(
          eq(clientLink.tenantId, contracts.tenantId),
          eq(clientLink.connector, connector),
          eq(clientLink.entity, 'client'),
          eq(clientLink.localId, contracts.clientId),
          isNull(clientLink.removedAt),
        ),
      )
      .where(
        and(
          eq(contracts.tenantId, tenantId),
          isNull(contracts.deletedAt),
          filter.linked === undefined ? undefined : filter.linked ? isNotNull(contractLink.id) : isNull(contractLink.id),
          filter.after ? gt(contracts.id, filter.after) : undefined,
        ),
      )
      .orderBy(asc(contracts.id))
      .limit(filter.limit),
  )
  return rows.map((row) => ({
    contratId: row.id,
    dolibarrId: row.crmId,
    reference: row.reference,
    tiers: { clientId: row.clientId, dolibarrId: row.clientCrmId, nom: row.clientName },
    type: row.contractType,
    statut: crmContractStatusWords[row.status],
    debut: row.startsOn,
    fin: row.endsOn,
    resilieLe: row.terminatedOn,
    ressource: row.resourceCode,
  }))
}
