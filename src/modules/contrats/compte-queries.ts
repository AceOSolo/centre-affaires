import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { readContractSnapshot, type ContractSnapshot } from './instantane.ts'
import {
  contractAmendments,
  contractDocuments,
  contracts,
  type BillingPeriod,
  type ContractStatus,
  type ContractType,
} from './schema.ts'

/**
 * Contrats vus depuis l'espace client (R17, ADR 015, ADR 019) : ceux des
 * entreprises du compte, et d'elles seules. Deux verrous, comme pour les
 * réservations : le filtre sur `client_id`, et la portée client de la
 * transaction (`inClientSpace`), qui tiendrait sans lui.
 *
 * Jamais de brouillon : un contrat en négociation n'engage rien et n'a pas de
 * document (ADR 025). Jamais un contrat archivé (`deleted_at`) : l'archivage
 * retire un contrat saisi par erreur. Jamais un avenant brouillon : seuls les
 * avenants signés font partie du contrat.
 */

export type ClientContractAmendment = {
  number: number
  effectiveOn: string
  reason: string | null
  /** Nouveau montant HT par période ; nul : le prix ne change pas. */
  amountCents: number | null
  changesResource: boolean
  /** Ressource après l'avenant, quand il la change ; nulle : retirée. */
  resourceName: string | null
}

export type ClientContractDocument = {
  version: number
  /** Nul : le contrat initial. */
  amendmentNumber: number | null
  createdAt: Date
}

export type ClientContractRow = {
  id: string
  clientId: string
  clientName: string
  reference: string
  contractType: ContractType
  status: Exclude<ContractStatus, 'draft'>
  startsOn: string
  endsOn: string | null
  terminatedOn: string | null
  billingPeriod: BillingPeriod
  currency: string
  commitmentMonths: number | null
  commitmentEndsOn: string | null
  noticeDays: number
  tacitRenewal: boolean
  renewalMonths: number | null
  offerName: string | null
  /** Montant HT par période de la version de prix en vigueur ce jour-là. */
  currentAmountCents: number
  /** Ressource en vigueur ce jour-là ; nulle : aucune ressource attribuée. */
  currentResource: { name: string; resourceType: ResourceType } | null
  /** Avenants signés, du premier au dernier. */
  amendments: ClientContractAmendment[]
  /** Documents archivés, du plus récent au plus ancien. */
  documents: ClientContractDocument[]
}

/**
 * Contrats des entreprises du compte, en cours d'abord, puis du plus récent au
 * plus ancien. `today` est le jour du centre : il choisit la version de prix et
 * la ressource en vigueur (ADR 025).
 */
export async function listContractsForAccounts(
  accounts: readonly ClientAccount[],
  today: string,
): Promise<ClientContractRow[]> {
  if (accounts.length === 0) return []
  const clientIds = accounts.map((account) => account.clientId)
  const ids = sql.join(
    clientIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

  return inClientSpace(accounts, async (tx) => {
    const heads = (await tx.execute(sql`
      select k.id, k.client_id, c.name as client_name, k.reference, k.contract_type, k.status,
             k.starts_on::text as starts_on, k.ends_on::text as ends_on,
             k.terminated_on::text as terminated_on, k.billing_period, k.currency,
             k.commitment_months, k.commitment_ends_on::text as commitment_ends_on,
             k.notice_days, k.tacit_renewal, k.renewal_months, o.name as offer_name,
             coalesce(
               (select v.amount_cents from contract_price_versions(k.id) as v
                 where v.starts_on <= greatest(${today}::date, k.starts_on)
                 order by v.starts_on desc limit 1),
               k.amount_cents) as current_amount_cents,
             (select r.name from contract_segments(k) as s
                join resources as r on r.id = s.resource_id
               where s.starts_on <= greatest(${today}::date, k.starts_on)
               order by s.starts_on desc limit 1) as resource_name,
             (select r.resource_type::text from contract_segments(k) as s
                join resources as r on r.id = s.resource_id
               where s.starts_on <= greatest(${today}::date, k.starts_on)
               order by s.starts_on desc limit 1) as resource_type
        from contracts as k
        join clients as c on c.id = k.client_id
        left join offers as o on o.id = k.offer_id
       where k.client_id in (${ids})
         and k.status <> 'draft'
         and k.deleted_at is null
       order by (k.status = 'active') desc, k.starts_on desc, k.reference`)) as unknown as {
      id: string
      client_id: string
      client_name: string
      reference: string
      contract_type: ContractType
      status: Exclude<ContractStatus, 'draft'>
      starts_on: string
      ends_on: string | null
      terminated_on: string | null
      billing_period: BillingPeriod
      currency: string
      commitment_months: number | null
      commitment_ends_on: string | null
      notice_days: number
      tacit_renewal: boolean
      renewal_months: number | null
      offer_name: string | null
      current_amount_cents: number
      resource_name: string | null
      resource_type: ResourceType | null
    }[]
    if (heads.length === 0) return []
    const contractIds = heads.map((head) => head.id)

    const amendments = await tx
      .select({
        contractId: contractAmendments.contractId,
        number: contractAmendments.number,
        effectiveOn: contractAmendments.effectiveOn,
        reason: contractAmendments.reason,
        amountCents: contractAmendments.amountCents,
        changesResource: contractAmendments.changesResource,
        resourceName: sql<string | null>`(select r.name from resources as r
          where r.tenant_id = ${contractAmendments.tenantId} and r.id = ${contractAmendments.resourceId})`,
      })
      .from(contractAmendments)
      .where(
        and(
          inArray(contractAmendments.contractId, contractIds),
          eq(contractAmendments.status, 'signed'),
          isNull(contractAmendments.deletedAt),
        ),
      )
      .orderBy(asc(contractAmendments.number))

    const documents = await tx
      .select({
        contractId: contractDocuments.contractId,
        version: contractDocuments.version,
        amendmentNumber: contractAmendments.number,
        createdAt: contractDocuments.createdAt,
      })
      .from(contractDocuments)
      .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
      .where(inArray(contractDocuments.contractId, contractIds))
      .orderBy(desc(contractDocuments.version))

    return heads.map((head) => ({
      id: head.id,
      clientId: head.client_id,
      clientName: head.client_name,
      reference: head.reference,
      contractType: head.contract_type,
      status: head.status,
      startsOn: head.starts_on,
      endsOn: head.ends_on,
      terminatedOn: head.terminated_on,
      billingPeriod: head.billing_period,
      currency: head.currency,
      commitmentMonths: head.commitment_months,
      commitmentEndsOn: head.commitment_ends_on,
      noticeDays: head.notice_days,
      tacitRenewal: head.tacit_renewal,
      renewalMonths: head.renewal_months,
      offerName: head.offer_name,
      currentAmountCents: head.current_amount_cents,
      currentResource:
        head.resource_name && head.resource_type
          ? { name: head.resource_name, resourceType: head.resource_type }
          : null,
      amendments: amendments
        .filter((amendment) => amendment.contractId === head.id)
        .map((amendment) => ({
          number: amendment.number,
          effectiveOn: amendment.effectiveOn,
          reason: amendment.reason,
          amountCents: amendment.amountCents,
          changesResource: amendment.changesResource,
          resourceName: amendment.resourceName,
        })),
      documents: documents
        .filter((document) => document.contractId === head.id)
        .map((document) => ({
          version: document.version,
          amendmentNumber: document.amendmentNumber,
          createdAt: document.createdAt,
        })),
    }))
  })
}

export type ClientArchivedDocument = {
  contractId: string
  reference: string
  version: number
  amendmentNumber: number | null
  sha256: string
  createdAt: Date
  /** Nul : forme d'instantané inconnue de ce code. */
  snapshot: ContractSnapshot | null
  /** L'empreinte recalculée par la base correspond-elle à celle archivée ? */
  intact: boolean
}

/**
 * Un document archivé d'un contrat du compte, par sa version, avec la
 * vérification de son empreinte par la base. `undefined` pour un contrat
 * d'une autre entreprise, un brouillon, un contrat archivé ou une version
 * inconnue : même réponse dans tous les cas, pour ne rien révéler des autres.
 */
export async function findContractDocumentForAccounts(
  contractId: string,
  version: number,
  accounts: readonly ClientAccount[],
): Promise<ClientArchivedDocument | undefined> {
  if (accounts.length === 0 || !isUuid(contractId) || !Number.isInteger(version) || version < 1) {
    return undefined
  }
  const clientIds = accounts.map((account) => account.clientId)
  const [row] = await inClientSpace(accounts, (tx) =>
    tx
      .select({
        contractId: contractDocuments.contractId,
        reference: contracts.reference,
        version: contractDocuments.version,
        amendmentNumber: contractAmendments.number,
        sha256: contractDocuments.sha256,
        createdAt: contractDocuments.createdAt,
        snapshot: contractDocuments.snapshot,
        intact: sql<boolean>`encode(sha256(convert_to(${contractDocuments.snapshot}::text, 'UTF8')), 'hex') = ${contractDocuments.sha256}`,
      })
      .from(contractDocuments)
      .innerJoin(contracts, eq(contracts.id, contractDocuments.contractId))
      .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
      .where(
        and(
          eq(contractDocuments.contractId, contractId),
          eq(contractDocuments.version, version),
          inArray(contracts.clientId, clientIds),
          ne(contracts.status, 'draft'),
          isNull(contracts.deletedAt),
        ),
      )
      .limit(1),
  )
  if (!row) return undefined
  return { ...row, snapshot: readContractSnapshot(row.snapshot) ?? null }
}
