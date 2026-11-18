import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { currentTenantId } from '../../lib/tenant.ts'
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
 * entreprises du compte, et d'elles seules. MySQL n'a pas de Row Level
 * Security : la base ne filtre pas les lectures, **chaque requête** de ce
 * fichier filtre donc elle-même sur les `clientIds` du compte (conventions §6),
 * y compris celles qui lisent les avenants et les documents. La portée client
 * de la transaction (`inClientSpace`) garde, elle, les écritures.
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
    clientIds.map((id) => sql`${id}`),
    sql`, `,
  )

  return inClientSpace(accounts, async (tx) => {
    // Les vues `contract_price_versions` et `contract_segments` (40-contrats.sql)
    // se joignent par `contract_id` ; `greatest` ne reçoit jamais de NULL ici.
    const [heads] = (await tx.execute(sql`
      select k.id, k.client_id, c.name as client_name, k.reference, k.contract_type, k.status,
             cast(k.starts_on as char) as starts_on, cast(k.ends_on as char) as ends_on,
             cast(k.terminated_on as char) as terminated_on, k.billing_period, k.currency,
             k.commitment_months, cast(k.commitment_ends_on as char) as commitment_ends_on,
             k.notice_days, k.tacit_renewal, k.renewal_months, o.name as offer_name,
             coalesce(
               (select v.amount_cents from contract_price_versions as v
                 where v.contract_id = k.id
                   and v.starts_on <= greatest(cast(${today} as date), k.starts_on)
                 order by v.starts_on desc limit 1),
               k.amount_cents) as current_amount_cents,
             (select r.name from contract_segments as s
                join resources as r on r.id = s.resource_id
               where s.contract_id = k.id
                 and s.starts_on <= greatest(cast(${today} as date), k.starts_on)
               order by s.starts_on desc limit 1) as resource_name,
             (select r.resource_type from contract_segments as s
                join resources as r on r.id = s.resource_id
               where s.contract_id = k.id
                 and s.starts_on <= greatest(cast(${today} as date), k.starts_on)
               order by s.starts_on desc limit 1) as resource_type
        from contracts as k
        join clients as c on c.id = k.client_id
        left join offers as o on o.id = k.offer_id
       where k.client_id in (${ids})
         and k.status <> 'draft'
         and k.deleted_at is null
       order by (k.status = 'active') desc, k.starts_on desc, k.reference`)) as unknown as [
      {
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
        tacit_renewal: number | boolean
        renewal_months: number | null
        offer_name: string | null
        current_amount_cents: number
        resource_name: string | null
        resource_type: ResourceType | null
      }[],
    ]
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
      .innerJoin(contracts, eq(contracts.id, contractAmendments.contractId))
      .where(
        and(
          inArray(contracts.clientId, clientIds),
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
      .innerJoin(contracts, eq(contracts.id, contractDocuments.contractId))
      .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
      .where(
        and(
          inArray(contracts.clientId, clientIds),
          inArray(contractDocuments.contractId, contractIds),
        ),
      )
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
      tacitRenewal: Boolean(head.tacit_renewal),
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
        intact: sql<boolean>`sha2(cast(${contractDocuments.snapshot} as char character set utf8mb4), 256) = ${contractDocuments.sha256}`.mapWith(Boolean),
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

/* ------------------------------------------------------------------------ */
/* Frais fixes, pour « Mes dépenses » (ADR 081)                              */
/* ------------------------------------------------------------------------ */

export type ClientContractFees = {
  contractId: string
  clientId: string
  reference: string
  contractType: ContractType
  billingPeriod: BillingPeriod
  currency: string
  startsOn: string
  /** Dernier jour : le plus proche du terme et de la résiliation ; nul : sans terme. */
  lastDay: string | null
  /** Versions de prix HT par période (`contract_price_versions`, avenants signés compris). */
  prices: { startsOn: string; endsOn: string | null; amountCents: number }[]
}

/**
 * Contrats des entreprises du compte qui ont couru entre `fromDay` et
 * `toDay` (jours du centre, bornes comprises), avec leurs versions de prix :
 * les frais fixes de « Mes dépenses » (ADR 081). Comme ailleurs dans
 * l'espace : jamais un brouillon ni un contrat archivé, et chaque requête
 * filtre elle-même sur le centre et les entreprises du compte.
 */
export async function listContractFeesForAccounts(
  accounts: readonly ClientAccount[],
  fromDay: string,
  toDay: string,
): Promise<ClientContractFees[]> {
  if (accounts.length === 0) return []
  const tenantId = currentTenantId()
  const ids = sql.join(
    accounts.map((account) => sql`${account.clientId}`),
    sql`, `,
  )

  return inClientSpace(accounts, async (tx) => {
    const [heads] = (await tx.execute(sql`
      select id, client_id, reference, contract_type, billing_period, currency,
             cast(starts_on as char) as starts_on, cast(last_day as char) as last_day
        from (select k.id, k.client_id, k.reference, k.contract_type, k.billing_period, k.currency, k.starts_on,
                     case when k.ends_on is null then k.terminated_on
                          when k.terminated_on is null then k.ends_on
                          else least(k.ends_on, k.terminated_on) end as last_day
                from contracts as k
               where k.tenant_id = ${tenantId}
                 and k.client_id in (${ids})
                 and k.status in ('active', 'terminated')
                 and k.deleted_at is null) as c
       where c.starts_on <= cast(${toDay} as date)
         and (c.last_day is null or c.last_day >= cast(${fromDay} as date))
       order by c.starts_on, c.reference`)) as unknown as [
      {
        id: string
        client_id: string
        reference: string
        contract_type: ContractType
        billing_period: BillingPeriod
        currency: string
        starts_on: string
        last_day: string | null
      }[],
    ]
    if (heads.length === 0) return []
    const contractIds = sql.join(
      heads.map((head) => sql`${head.id}`),
      sql`, `,
    )
    const [versions] = (await tx.execute(sql`
      select v.contract_id, cast(v.starts_on as char) as starts_on, cast(v.ends_on as char) as ends_on, v.amount_cents
        from contract_price_versions as v
       where v.tenant_id = ${tenantId} and v.contract_id in (${contractIds})
       order by v.starts_on`)) as unknown as [
      { contract_id: string; starts_on: string; ends_on: string | null; amount_cents: number }[],
    ]

    return heads.map((head) => ({
      contractId: head.id,
      clientId: head.client_id,
      reference: head.reference,
      contractType: head.contract_type,
      billingPeriod: head.billing_period,
      currency: head.currency,
      startsOn: head.starts_on,
      lastDay: head.last_day,
      prices: versions
        .filter((version) => version.contract_id === head.id)
        .map((version) => ({
          startsOn: version.starts_on,
          endsOn: version.ends_on,
          amountCents: Number(version.amount_cents),
        })),
    }))
  })
}
