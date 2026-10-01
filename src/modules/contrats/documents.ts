import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { offers } from '../facturation/schema.ts'
import { resources } from '../ressources/schema.ts'
import {
  buildContractSnapshot,
  readContractSnapshot,
  type ContractSnapshot,
  type SnapshotInput,
  type SnapshotResourceInput,
} from './instantane.ts'
import { contractAmendments, contractDocuments, contracts, type ContractDocument } from './schema.ts'
import { selectContractSubscriptions } from './souscriptions.ts'
import {
  segmentOn,
  selectContractLines,
  selectPriceVersions,
  selectSegments,
  type ContractLineWithTarget,
} from './versions.ts'

/**
 * Documents d'un contrat (R12, ADR 025) : chaque version remise au client —
 * le contrat à son activation, chaque avenant à sa signature — archivée en
 * instantané structuré dans `contract_documents`. La base attribue la version
 * (1, 2, 3…) et calcule l'empreinte SHA-256 de `snapshot::text` ; un document
 * ne se réécrit pas.
 */

function lineInput(line: ContractLineWithTarget) {
  return {
    description: line.description,
    targetLabel: line.targetLabel,
    quantity: line.quantity,
    unit: line.unit,
    unitPriceCents: line.unitPriceCents,
    discountBp: line.discountBp,
    discountAmountCents: line.discountAmountCents,
    vatRateBp: line.vatRateBp,
    netAmountCents: line.netAmountCents ?? 0,
    isRecurring: line.isRecurring,
  }
}

const asResource = (
  resource: { code: string; name: string; resourceType: SnapshotResourceInput['resourceType'] } | null,
): SnapshotResourceInput | null =>
  resource ? { code: resource.code, name: resource.name, resourceType: resource.resourceType } : null

/**
 * Lit, dans la transaction de l'appelant, tout ce que le document d'une
 * version montre : le contrat initial (`amendmentId` nul) ou un avenant.
 *
 * Pour un avenant : ses lignes s'il change le prix, sinon celles de la version
 * de prix en vigueur à sa date d'effet ; la ressource après l'avenant, et
 * celle d'avant s'il la change. `undefined` si le contrat ou l'avenant
 * n'existe pas.
 */
export async function selectSnapshotInput(
  tx: Transaction,
  contractId: string,
  amendmentId: string | null,
): Promise<SnapshotInput | undefined> {
  const [row] = await tx
    .select({ contract: contracts, client: clients, tenant: tenants, offerName: offers.name })
    .from(contracts)
    .innerJoin(clients, eq(clients.id, contracts.clientId))
    .innerJoin(tenants, eq(tenants.id, contracts.tenantId))
    .leftJoin(offers, eq(offers.id, contracts.offerId))
    .where(eq(contracts.id, contractId))
  if (!row) return undefined
  const { contract, client, tenant } = row

  const subscriptions = (await selectContractSubscriptions(tx, contractId)).map(
    ({ subscription, serviceName }) => ({
      serviceName,
      includedQuantity: subscription.includedQuantity,
      quantity: subscription.quantity,
      unit: subscription.unit,
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
      discountAmountCents: subscription.discountAmountCents,
      vatRateBp: subscription.vatRateBp,
      startsOn: subscription.startsOn,
      endsOn: subscription.endsOn,
    }),
  )

  const base = {
    issuedOn: todayIsoDate(tenant.timezone),
    tenant,
    client,
    contract,
    offerName: row.offerName,
    subscriptions,
  }

  if (amendmentId === null) {
    const [resource] = contract.resourceId
      ? await tx.select().from(resources).where(eq(resources.id, contract.resourceId))
      : []
    const lines = await selectContractLines(tx, contractId, { amendmentId: null })
    return {
      ...base,
      resource: asResource(resource ?? null),
      lines: lines.map(lineInput),
      versionAmountCents: contract.amountCents,
      amendment: null,
    }
  }

  const [amendment] = await tx
    .select()
    .from(contractAmendments)
    .where(and(eq(contractAmendments.id, amendmentId), eq(contractAmendments.contractId, contractId)))
  if (!amendment) return undefined

  const ownLines = await selectContractLines(tx, contractId, { amendmentId })
  const priceChanged = ownLines.length > 0 || amendment.amountCents !== null
  let lines = ownLines
  let versionAmountCents = amendment.amountCents ?? contract.amountCents
  if (!priceChanged) {
    // Le prix ne change pas : le document reprend la version en vigueur.
    const version = segmentOn(await selectPriceVersions(tx, contractId), amendment.effectiveOn)
    lines = version?.lines ?? []
    versionAmountCents = version?.amountCents ?? contract.amountCents
  }

  const segments = await selectSegments(tx, contractId)
  const before = segmentOn(segments, addDaysToIsoDate(amendment.effectiveOn, -1))
  let resource: SnapshotResourceInput | null = asResource(
    segmentOn(segments, amendment.effectiveOn)?.resource ?? null,
  )
  if (amendment.changesResource) {
    // Un avenant brouillon n'est pas encore un segment : sa ressource est lue
    // sur lui-même.
    const [own] = amendment.resourceId
      ? await tx.select().from(resources).where(eq(resources.id, amendment.resourceId))
      : []
    resource = asResource(own ?? null)
  }

  return {
    ...base,
    resource,
    lines: lines.map(lineInput),
    versionAmountCents,
    amendment: {
      number: amendment.number,
      effectiveOn: amendment.effectiveOn,
      reason: amendment.reason,
      priceChanged,
      changesResource: amendment.changesResource,
      previousResource: amendment.changesResource ? asResource(before?.resource ?? null) : null,
    },
  }
}

/**
 * Archive le document d'une version dans la transaction de l'appelant : celle
 * qui active le contrat, ou qui signe l'avenant. Rend le document, avec la
 * version et l'empreinte que la base lui a données.
 */
export async function archiveContractDocument(
  tx: Transaction,
  target: { contractId: string; amendmentId: string | null; generatedBy: string | null },
): Promise<ContractDocument> {
  const input = await selectSnapshotInput(tx, target.contractId, target.amendmentId)
  if (!input) throw new Error('Contrat ou avenant introuvable : document non établi.')
  const [document] = await tx
    .insert(contractDocuments)
    .values({
      contractId: target.contractId,
      amendmentId: target.amendmentId,
      snapshot: buildContractSnapshot(input) as unknown as Record<string, unknown>,
      generatedBy: target.generatedBy,
    })
    .returning()
  return document
}

/**
 * Le document tel qu'il serait établi maintenant, sans l'archiver : aperçu
 * d'un brouillon de contrat ou d'avenant, ou contrat repris sans document.
 */
export async function previewContractSnapshot(
  contractId: string,
  amendmentId: string | null = null,
): Promise<ContractSnapshot | undefined> {
  const input = await withTenant(currentTenantId(), (tx) =>
    selectSnapshotInput(tx, contractId, amendmentId),
  )
  return input ? buildContractSnapshot(input) : undefined
}

/**
 * Établit le document du contrat initial quand il n'en a pas — un contrat
 * activé avant les documents (vague 1, reprise). Rend `false` si le contrat
 * est un brouillon ou a déjà son document initial.
 */
export async function establishContractDocument(
  contractId: string,
  generatedBy: string,
): Promise<ContractDocument | false> {
  return withTenant(currentTenantId(), async (tx) => {
    const [contract] = await tx
      .select({ status: contracts.status })
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('no key update')
    if (!contract || contract.status === 'draft') return false
    const [existing] = await tx
      .select({ id: contractDocuments.id })
      .from(contractDocuments)
      .where(
        and(
          eq(contractDocuments.contractId, contractId),
          sql`${contractDocuments.amendmentId} is null`,
        ),
      )
      .limit(1)
    if (existing) return false
    return archiveContractDocument(tx, { contractId, amendmentId: null, generatedBy })
  })
}

export type ContractDocumentSummary = {
  id: string
  version: number
  amendmentId: string | null
  amendmentNumber: number | null
  sha256: string
  createdAt: Date
  generatedBy: string | null
}

/** Documents archivés d'un contrat, du plus récent au plus ancien. */
export async function listContractDocuments(contractId: string): Promise<ContractDocumentSummary[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: contractDocuments.id,
        version: contractDocuments.version,
        amendmentId: contractDocuments.amendmentId,
        amendmentNumber: contractAmendments.number,
        sha256: contractDocuments.sha256,
        createdAt: contractDocuments.createdAt,
        author: staffMembers.fullName,
        authorEmail: staffMembers.email,
      })
      .from(contractDocuments)
      .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
      .leftJoin(staffMembers, eq(staffMembers.id, contractDocuments.generatedBy))
      .where(eq(contractDocuments.contractId, contractId))
      .orderBy(desc(contractDocuments.version)),
  )
  return rows.map(({ author, authorEmail, ...row }) => ({
    ...row,
    generatedBy: author ?? authorEmail ?? null,
  }))
}

export type ArchivedDocument = ContractDocumentSummary & {
  /** Nul : forme d'instantané inconnue de ce code. */
  snapshot: ContractSnapshot | null
  /** L'empreinte recalculée par la base correspond-elle à celle archivée ? */
  intact: boolean
}

/**
 * Un document archivé, par sa version, et la vérification de son empreinte :
 * la base recalcule le SHA-256 de l'instantané tel qu'il est stocké et le
 * compare à celui de l'archivage.
 */
export async function findContractDocument(
  contractId: string,
  version: number,
): Promise<ArchivedDocument | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: contractDocuments.id,
        version: contractDocuments.version,
        amendmentId: contractDocuments.amendmentId,
        amendmentNumber: contractAmendments.number,
        sha256: contractDocuments.sha256,
        createdAt: contractDocuments.createdAt,
        author: staffMembers.fullName,
        authorEmail: staffMembers.email,
        snapshot: contractDocuments.snapshot,
        intact: sql<boolean>`encode(sha256(convert_to(${contractDocuments.snapshot}::text, 'UTF8')), 'hex') = ${contractDocuments.sha256}`,
      })
      .from(contractDocuments)
      .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
      .leftJoin(staffMembers, eq(staffMembers.id, contractDocuments.generatedBy))
      .where(
        and(eq(contractDocuments.contractId, contractId), eq(contractDocuments.version, version)),
      )
      .orderBy(asc(contractDocuments.version))
      .limit(1),
  )
  if (!row) return undefined
  const { author, authorEmail, snapshot, ...rest } = row
  return {
    ...rest,
    generatedBy: author ?? authorEmail ?? null,
    snapshot: readContractSnapshot(snapshot) ?? null,
  }
}
