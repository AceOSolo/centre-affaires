import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import type { ClosurePeriod, OpeningRule } from './ouverture.ts'
import {
  closures,
  openingHours,
  type Closure,
  type OpeningHour,
} from './schema.ts'

/**
 * Lecture des règles d'ouverture.
 *
 * Toutes les règles du centre sont chargées d'un coup, y compris celles des
 * autres ressources : il y en a quelques dizaines, et un planning affiche de
 * toute façon toutes les colonnes. Une requête par ressource coûterait plus
 * cher que le filtrage en mémoire.
 */
export async function listOpeningHours(): Promise<OpeningHour[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(openingHours)
      .orderBy(asc(openingHours.weekday), asc(openingHours.opensAt)),
  )
}

/** Fermetures qui touchent la période demandée, bornes comprises. */
export async function listClosures(from: string, to: string): Promise<Closure[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(closures)
      .where(and(lte(closures.startsOn, to), gte(closures.endsOn, from)))
      .orderBy(asc(closures.startsOn)),
  )
}

/** Fermetures à venir, pour l'écran de gestion. */
export async function listUpcomingClosures(from: string): Promise<Closure[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(closures)
      .where(gte(closures.endsOn, from))
      .orderBy(asc(closures.startsOn)),
  )
}

/** Tout ce qu'il faut pour calculer les disponibilités d'une période. */
export type OpeningContext = {
  rules: OpeningRule[]
  closures: ClosurePeriod[]
}

export async function loadOpeningContext(from: string, to: string): Promise<OpeningContext> {
  const [rules, periods] = await Promise.all([listOpeningHours(), listClosures(from, to)])
  return { rules, closures: periods }
}

export type OpeningHourInput = {
  resourceId?: string | null
  weekday: number
  opensAt: string
  closesAt: string
}

export async function addOpeningHour(input: OpeningHourInput): Promise<OpeningHour> {
  const [created] = await withTenant(currentTenantId(), (tx) =>
    tx
      .insert(openingHours)
      .values({
        resourceId: input.resourceId || null,
        weekday: input.weekday,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
      })
      .returning(),
  )
  return created
}

/**
 * Suppression physique, et non logique : une plage horaire n'a ni historique ni
 * portée légale. La décision 6 vise les entités métier — contrat, facture, état
 * des lieux — pas un réglage qu'on corrige.
 */
export async function removeOpeningHour(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx.delete(openingHours).where(eq(openingHours.id, id)),
  )
}

/** Remplace d'un coup les horaires d'une ressource, ou ceux du centre. */
export async function replaceOpeningHours(
  resourceId: string | null,
  ranges: readonly { weekday: number; opensAt: string; closesAt: string }[],
): Promise<void> {
  await withTenant(currentTenantId(), async (tx) => {
    await tx
      .delete(openingHours)
      .where(
        resourceId
          ? eq(openingHours.resourceId, resourceId)
          : isNull(openingHours.resourceId),
      )
    if (ranges.length === 0) return
    await tx.insert(openingHours).values(
      ranges.map((range) => ({
        resourceId,
        weekday: range.weekday,
        opensAt: range.opensAt,
        closesAt: range.closesAt,
      })),
    )
  })
}

export type ClosureInput = {
  resourceId?: string | null
  startsOn: string
  endsOn: string
  reason?: string | null
}

export async function addClosure(input: ClosureInput): Promise<Closure> {
  const [created] = await withTenant(currentTenantId(), (tx) =>
    tx
      .insert(closures)
      .values({
        resourceId: input.resourceId || null,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        reason: input.reason?.trim() || null,
      })
      .returning(),
  )
  return created
}

export async function removeClosure(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) => tx.delete(closures).where(eq(closures.id, id)))
}

/** Ressources concernées par une fermeture : celle visée, ou tout le centre. */
export function closureApplies(closure: Closure, resourceId: string): boolean {
  return closure.resourceId === null || closure.resourceId === resourceId
}

/** Utilisé par l'écran de gestion pour n'afficher que ce qui vaut encore. */
export function closureIsPast(closure: Closure, today: string): boolean {
  return closure.endsOn < today
}
