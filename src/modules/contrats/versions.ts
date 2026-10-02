import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { offers, services } from '../facturation/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import type { ScheduleVersion } from './echeancier.ts'
import { contractLines, contracts, type ContractLine } from './schema.ts'

/**
 * Lecture d'un contrat versionné (R12, ADR 025) : lignes de chaque version,
 * versions de prix, segments de ressource. L'autorité est en base
 * (`contract_price_versions`, `contract_segments`, migration 0031) : ce module
 * ne fait que la lire, pour l'échéancier, la fiche et les documents.
 */

/** Une ligne de contrat et le libellé de ce qu'elle vise. */
export type ContractLineWithTarget = ContractLine & { targetLabel: string | null }

/** « Bureau 1 (BUR-A1) », « Bureau » (type), « Standard téléphonique », « Offre Premium ». */
export function lineTargetLabel(row: {
  resourceType: ResourceType | null
  resource: { code: string; name: string } | null
  serviceName: string | null
  offerName: string | null
}): string | null {
  if (row.resource) return `${row.resource.name} (${row.resource.code})`
  if (row.resourceType) return resourceTypeLabels[row.resourceType]
  return row.serviceName ?? row.offerName ?? null
}

/**
 * Lignes vivantes d'un contrat, toutes versions confondues ou celles d'une
 * version (`amendmentId` nul : version initiale), dans l'ordre d'affichage.
 */
export async function selectContractLines(
  tx: Transaction,
  contractId: string,
  version?: { amendmentId: string | null },
): Promise<ContractLineWithTarget[]> {
  const rows = await tx
    .select({
      line: contractLines,
      resource: { code: resources.code, name: resources.name },
      serviceName: services.name,
      offerName: offers.name,
    })
    .from(contractLines)
    .leftJoin(resources, eq(resources.id, contractLines.resourceId))
    .leftJoin(services, eq(services.id, contractLines.serviceId))
    .leftJoin(offers, eq(offers.id, contractLines.offerId))
    .where(
      and(
        eq(contractLines.contractId, contractId),
        isNull(contractLines.deletedAt),
        version === undefined
          ? undefined
          : version.amendmentId === null
            ? isNull(contractLines.amendmentId)
            : eq(contractLines.amendmentId, version.amendmentId),
      ),
    )
    .orderBy(asc(contractLines.position), asc(contractLines.createdAt), asc(contractLines.id))
  return rows.map((row) => ({
    ...row.line,
    targetLabel: lineTargetLabel({
      resourceType: row.line.resourceType,
      resource: row.resource?.code ? row.resource : null,
      serviceName: row.serviceName,
      offerName: row.offerName,
    }),
  }))
}

/** Une version de prix et ses lignes (`contract_price_versions`). */
export type PriceVersion = Omit<ScheduleVersion, 'lines'> & { lines: ContractLineWithTarget[] }

/**
 * Versions de prix d'un contrat, de la plus ancienne à la plus récente : la
 * version initiale, puis chaque avenant signé qui change le prix (ADR 025).
 * Chacune porte ses lignes vivantes ; sans ligne, elle se facture de son
 * montant, à la TVA du contrat.
 */
export async function selectPriceVersions(
  tx: Transaction,
  contractId: string,
): Promise<PriceVersion[]> {
  const rows = (await tx.execute(sql`
    select amendment_id, amendment_number, starts_on::text as starts_on,
           ends_on::text as ends_on, amount_cents
      from contract_price_versions(${contractId}::uuid)`)) as unknown as {
    amendment_id: string | null
    amendment_number: number | null
    starts_on: string
    ends_on: string | null
    amount_cents: number
  }[]
  const lines = await selectContractLines(tx, contractId)
  return rows.map((row) => ({
    amendmentId: row.amendment_id,
    amendmentNumber: row.amendment_number,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    amountCents: row.amount_cents,
    lines: lines.filter((line) => line.amendmentId === row.amendment_id),
  }))
}

/** Versions de prix, pour l'échéancier : les lignes au format de `contractSchedule`. */
export function scheduleVersions(versions: readonly PriceVersion[]): ScheduleVersion[] {
  return versions.map((version) => ({
    ...version,
    lines: version.lines.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      discountAmountCents: line.discountAmountCents,
      isRecurring: line.isRecurring,
    })),
  }))
}

/** Un segment de ressource du contrat (`contract_segments`, ADR 025). */
export type ContractSegment = {
  amendmentId: string | null
  amendmentNumber: number | null
  startsOn: string
  /** Nul : jusqu'au terme du contrat, ou sans terme. */
  endsOn: string | null
  resource: { id: string; code: string; name: string; resourceType: ResourceType } | null
}

/**
 * Segments de ressource d'un contrat : la ressource de la version initiale
 * depuis le premier jour, puis celle de chaque avenant signé qui la change.
 * `resource` nul : aucune ressource sur le segment.
 */
export async function selectSegments(tx: Transaction, contractId: string): Promise<ContractSegment[]> {
  const rows = (await tx.execute(sql`
    select s.amendment_id, s.amendment_number, s.starts_on::text as starts_on,
           s.ends_on::text as ends_on, r.id as resource_id, r.code, r.name, r.resource_type
      from contracts as k
     cross join lateral contract_segments(k) as s
      left join resources as r on r.id = s.resource_id
     where k.id = ${contractId}::uuid
     order by s.starts_on`)) as unknown as {
    amendment_id: string | null
    amendment_number: number | null
    starts_on: string
    ends_on: string | null
    resource_id: string | null
    code: string | null
    name: string | null
    resource_type: ResourceType | null
  }[]
  return rows.map((row) => ({
    amendmentId: row.amendment_id,
    amendmentNumber: row.amendment_number,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    resource:
      row.resource_id && row.code && row.name && row.resource_type
        ? { id: row.resource_id, code: row.code, name: row.name, resourceType: row.resource_type }
        : null,
  }))
}

/**
 * Le segment en vigueur ce jour-là : celui qui le contient ; avant le début,
 * le premier ; après le terme, le dernier. `undefined` sans segment (contrat
 * résilié avant son début).
 */
export function segmentOn<T extends { startsOn: string; endsOn: string | null }>(
  segments: readonly T[],
  day: string,
): T | undefined {
  const current = segments.find(
    (segment) => segment.startsOn <= day && (segment.endsOn === null || segment.endsOn >= day),
  )
  if (current) return current
  if (segments.length > 0 && day < segments[0].startsOn) return segments[0]
  return segments.at(-1)
}

/** Ce que la fiche d'un contrat montre de ses versions. */
export type ContractTerms = {
  versions: PriceVersion[]
  segments: ContractSegment[]
  /** Nom de l'offre d'origine (archivée comprise) ; nul sans offre. */
  offerName: string | null
  /** Dernier jour déjà facturé (`contract_billed_through`) ; nul : rien. */
  billedThrough: string | null
}

/**
 * Dernier jour du contrat que tient une facture, émise ou brouillon (loyers
 * et lignes du contrat, ni retirés ni libérés par un avoir) : un avenant de
 * prix prend effet au plus tôt le lendemain (ADR 032). Nul : rien de facturé.
 */
export async function selectBilledThrough(tx: Transaction, contractId: string): Promise<string | null> {
  const [row] = await tx.execute<{ billed_through: string | null }>(
    sql`select contract_billed_through(${contractId}::uuid)::text as billed_through`,
  )
  return row?.billed_through ?? null
}

export async function findContractBilledThrough(contractId: string): Promise<string | null> {
  return withTenant(currentTenantId(), (tx) => selectBilledThrough(tx, contractId))
}

/** Versions de prix et segments de ressource d'un contrat, en une transaction. */
export async function findContractTerms(contractId: string): Promise<ContractTerms> {
  return withTenant(currentTenantId(), async (tx) => {
    const [offer] = await tx
      .select({ name: offers.name })
      .from(contracts)
      .innerJoin(offers, eq(offers.id, contracts.offerId))
      .where(eq(contracts.id, contractId))
    return {
      versions: await selectPriceVersions(tx, contractId),
      segments: await selectSegments(tx, contractId),
      offerName: offer?.name ?? null,
      billedThrough: await selectBilledThrough(tx, contractId),
    }
  })
}

/**
 * Prix et ressource en vigueur ce jour-là pour une liste de contrats : la
 * liste des contrats montre la version courante, pas la version initiale
 * qu'`amount_cents` et `resource_id` gardent (ADR 025).
 */
export async function listCurrentTerms(
  contractIds: readonly string[],
  day: string,
): Promise<Map<string, { amountCents: number; resourceCode: string | null }>> {
  if (contractIds.length === 0) return new Map()
  const rows = await withTenant(currentTenantId(), async (tx) => {
    const ids = sql.join(
      contractIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )
    return (await tx.execute(sql`
      select k.id,
             (select v.amount_cents from contract_price_versions(k.id) as v
               where v.starts_on <= greatest(${day}::date, k.starts_on)
               order by v.starts_on desc limit 1) as amount_cents,
             (select r.code from contract_segments(k) as s
                join resources as r on r.id = s.resource_id
               where s.starts_on <= greatest(${day}::date, k.starts_on)
               order by s.starts_on desc limit 1) as resource_code
        from contracts as k
       where k.id in (${ids})`)) as unknown as {
      id: string
      amount_cents: number | null
      resource_code: string | null
    }[]
  })
  return new Map(
    rows
      .filter((row) => row.amount_cents !== null)
      .map((row) => [
        row.id,
        { amountCents: row.amount_cents as number, resourceCode: row.resource_code },
      ]),
  )
}

/**
 * Occupations d'un contrat, une par segment de ressource (ADR 025), annulées
 * comprises — elles disent pourquoi une ressource a été libérée — du premier
 * segment au dernier, avec leur ressource.
 */
export async function listContractOccupations(contractId: string) {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        booking: bookings,
        resource: { code: resources.code, name: resources.name },
      })
      .from(bookings)
      .leftJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(eq(bookings.contractId, contractId), eq(bookings.kind, 'contract')))
      .orderBy(asc(bookings.startsAt)),
  )
}

/** Lignes vivantes de plusieurs avenants, groupées par avenant. */
export async function selectAmendmentLines(
  tx: Transaction,
  contractId: string,
  amendmentIds: readonly string[],
): Promise<Map<string, ContractLineWithTarget[]>> {
  const grouped = new Map<string, ContractLineWithTarget[]>()
  if (amendmentIds.length === 0) return grouped
  const lines = (await selectContractLines(tx, contractId)).filter(
    (line) => line.amendmentId !== null && amendmentIds.includes(line.amendmentId),
  )
  for (const line of lines) {
    const key = line.amendmentId as string
    grouped.set(key, [...(grouped.get(key) ?? []), line])
  }
  return grouped
}
