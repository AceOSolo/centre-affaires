import type { InspectionKind, InspectionStatus } from './schema.ts'

/**
 * Occupations et états des lieux (ADR 063), sans base ni rendu : de quoi dire
 * ce qu'une occupation attend encore — une entrée, une sortie, rien — et
 * ranger l'historique d'une ressource par occupation.
 *
 * Une **occupation**, c'est ce qu'un état des lieux d'entrée ouvre et ce que
 * sa sortie clôt :
 *
 * - une réservation (`bookings.kind` autre que `contract`) ;
 * - un contrat sur une ressource, qu'il ait déjà son occupation
 *   (`kind = 'contract'`, ADR 018) ou qu'il soit encore en brouillon : l'entrée
 *   faite avant l'activation reste celle de l'occupation qui suit.
 *
 * Même définition que la base : la garde « une entrée par occupation » de
 * `80-etats-des-lieux.sql` et `inspection_occupation_end()` de
 * `85-restitution.sql`.
 */

export type OccupationRef = {
  resourceId: string
  bookingId: string | null
  /** `bookings.kind` de la réservation ; `contract` pour une occupation de contrat. */
  bookingKind: string | null
  contractId: string | null
}

/** Clé d'une occupation : `b:<réservation>`, ou `c:<contrat>:<ressource>`. */
export function occupationKey(ref: OccupationRef): string | null {
  if (ref.bookingId && ref.bookingKind !== 'contract') return `b:${ref.bookingId}`
  if (ref.contractId) return `c:${ref.contractId}:${ref.resourceId}`
  // Occupation de contrat sans contrat : la base ne l'écrit pas, on reste prudent.
  if (ref.bookingId) return `b:${ref.bookingId}`
  return null
}

/** Le minimum d'un état des lieux pour situer son occupation. */
export type InspectionBrief = OccupationRef & {
  id: string
  kind: InspectionKind
  status: InspectionStatus
  /** Pour une sortie : l'entrée qu'elle clôt. */
  entryInspectionId: string | null
  performedAt: Date
}

/**
 * Où en est une occupation :
 *
 * - `none` : aucune entrée — on peut la faire (ou une sortie, si l'entrée a
 *   été faite hors de l'application) ;
 * - `entry_draft` : l'entrée est en saisie, à terminer avant la sortie ;
 * - `entry_closed` : l'entrée est close, seule la sortie reste ;
 * - `exit_draft` : la sortie est en saisie ;
 * - `done` : entrée et sortie closes.
 */
export type OccupationProgress =
  | { step: 'none' }
  | { step: 'entry_draft'; entryId: string }
  | { step: 'entry_closed'; entryId: string }
  | { step: 'exit_draft'; entryId: string; exitId: string }
  | { step: 'done'; entryId: string; exitId: string }

/**
 * Étape d'une occupation, d'après les états des lieux vivants (brouillons
 * retirés exclus) de sa ressource. S'il en reste plusieurs d'avant la règle
 * d'unicité, la plus récente des entrées fait foi.
 */
export function occupationProgress(key: string, inspections: readonly InspectionBrief[]): OccupationProgress {
  const entry = inspections
    .filter((row) => row.kind === 'entry' && occupationKey(row) === key)
    .toSorted((a, b) => b.performedAt.getTime() - a.performedAt.getTime())[0]
  if (!entry) return { step: 'none' }
  if (entry.status === 'draft') return { step: 'entry_draft', entryId: entry.id }
  const exit = inspections.find((row) => row.kind === 'exit' && row.entryInspectionId === entry.id)
  if (!exit) return { step: 'entry_closed', entryId: entry.id }
  return exit.status === 'closed'
    ? { step: 'done', entryId: entry.id, exitId: exit.id }
    : { step: 'exit_draft', entryId: entry.id, exitId: exit.id }
}

/** Une entrée s'ouvre seulement sur une occupation qui n'en a pas (ADR 063). */
export function canOpenEntry(progress: OccupationProgress): boolean {
  return progress.step === 'none'
}

/**
 * Une sortie s'ouvre sur une occupation dont l'entrée est close et sans
 * sortie — elle clôt alors cette entrée —, ou qui n'a pas d'entrée du tout.
 */
export function canOpenExit(progress: OccupationProgress): boolean {
  return progress.step === 'none' || progress.step === 'entry_closed'
}

/** Pourquoi rien ne s'ouvre, en une phrase, pour l'écran. */
export function progressHint(progress: OccupationProgress): string | null {
  switch (progress.step) {
    case 'entry_draft':
      return 'Entrée en saisie : terminez-la et close-la, la sortie s’ouvrira ensuite.'
    case 'entry_closed':
      return 'Entrée faite : seule la sortie reste à faire.'
    case 'exit_draft':
      return 'Sortie en saisie : terminez-la et close-la pour rendre la ressource.'
    case 'done':
      return 'Entrée et sortie faites pour cette occupation.'
    case 'none':
      return null
  }
}

/* -------------------------------------------------------------------------- */
/* Chronologie d'une ressource                                                */
/* -------------------------------------------------------------------------- */

/**
 * Situation d'une occupation dans la chronologie :
 *
 * - `entree_en_saisie`, `en_cours`, `sortie_en_saisie`, `restituee` ;
 * - `non_restituee` : fin prévue dépassée sans sortie close (ADR 063) ;
 * - `sortie_seule` : une sortie sans entrée dans l'application.
 */
export type OccupationSituation =
  | 'entree_en_saisie'
  | 'en_cours'
  | 'non_restituee'
  | 'sortie_en_saisie'
  | 'restituee'
  | 'sortie_seule'

export type TimelineGroup<T> = {
  key: string
  entry: T | null
  exit: T | null
  situation: OccupationSituation
  /** Date de l'entrée, à défaut de la sortie : l'ordre de la chronologie. */
  startedAt: Date
}

/**
 * Range les états des lieux vivants d'une ressource par occupation : une
 * entrée et la sortie qui la clôt forment un groupe ; une sortie sans entrée
 * forme le sien. Les plus récentes d'abord ; dans un groupe, l'entrée puis la
 * sortie.
 *
 * `unreturnedSince` vient de la base (`inspection_unreturned_since()`) : seule
 * elle dit qu'une fin prévue est dépassée, au même instant que son trigger.
 */
export function groupByOccupation<T extends InspectionBrief & { unreturnedSince?: Date | null }>(
  rows: readonly T[],
): TimelineGroup<T>[] {
  const entries = rows.filter((row) => row.kind === 'entry')
  const entryIds = new Set(entries.map((row) => row.id))
  const groups: TimelineGroup<T>[] = entries.map((entry) => {
    const exit = rows.find((row) => row.kind === 'exit' && row.entryInspectionId === entry.id) ?? null
    const situation: OccupationSituation =
      entry.status === 'draft'
        ? 'entree_en_saisie'
        : exit
          ? exit.status === 'closed'
            ? 'restituee'
            : 'sortie_en_saisie'
          : entry.unreturnedSince
            ? 'non_restituee'
            : 'en_cours'
    return { key: entry.id, entry, exit, situation, startedAt: entry.performedAt }
  })
  for (const exit of rows) {
    if (exit.kind !== 'exit' || (exit.entryInspectionId && entryIds.has(exit.entryInspectionId))) continue
    groups.push({ key: exit.id, entry: null, exit, situation: 'sortie_seule', startedAt: exit.performedAt })
  }
  return groups.toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
}

export const occupationSituationLabels: Record<OccupationSituation, string> = {
  entree_en_saisie: 'Entrée en saisie',
  en_cours: 'En cours',
  non_restituee: 'Non restituée',
  sortie_en_saisie: 'Sortie en saisie',
  restituee: 'Restituée',
  sortie_seule: 'Sortie sans entrée',
}

/**
 * Pastilles de situation, sur les bleus de la charte ; le rouge du conflit
 * (`--statut-conflit`) pour le seul cas anormal, la ressource non restituée.
 * Le libellé porte toujours le sens. Le rouge sur fond blanc (4,8:1) : sur
 * son propre aplat clair, il passerait sous 4,5:1.
 */
export const occupationSituationStyles: Record<OccupationSituation, string> = {
  entree_en_saisie: 'border border-border bg-white text-foreground',
  en_cours: 'border border-primary bg-white text-primary',
  non_restituee: 'border border-statut-conflit bg-white text-statut-conflit',
  sortie_en_saisie: 'border border-border bg-white text-foreground',
  restituee: 'bg-primary text-primary-foreground',
  sortie_seule: 'bg-muted text-muted-foreground',
}
