import { formatInspectionValue, formatNumber, isFilled } from './champs.ts'
import { conditionLevelLabels, conditionLevelOrder } from './labels.ts'
import type { InspectionConditionLevel, InspectionField, InspectionValues } from './schema.ts'

/**
 * Comparaison d'une sortie à son entrée (R06, ADR 039), champ par champ.
 *
 * Les deux états des lieux peuvent avoir été saisis avec des versions
 * différentes du modèle : les champs se rapprochent par leur identifiant, qui
 * ne change pas d'une version à l'autre. Chaque écart est **dit** — dégradé,
 * changé, écart chiffré —, jamais seulement coloré (`CLAUDE.md`).
 *
 * Module pur : `comparaison.test.ts`.
 */

export type ComparisonChange =
  /** Même valeur des deux côtés. */
  | 'same'
  /** Non renseigné des deux côtés. */
  | 'empty'
  /** Note d'état moins bonne à la sortie. */
  | 'worse'
  /** Note d'état meilleure à la sortie. */
  | 'better'
  /** Valeur différente, sans sens de « mieux » ou « moins bien ». */
  | 'changed'
  /** Renseigné à la sortie seulement. */
  | 'added'
  /** Renseigné à l'entrée, plus à la sortie. */
  | 'missing'
  /** Le champ n'existe que dans le modèle de l'entrée. */
  | 'entry_only'
  /** Le champ n'existe que dans le modèle de la sortie. */
  | 'exit_only'

export type ComparisonRow = {
  fieldId: string
  label: string
  entry: string | null
  exit: string | null
  change: ComparisonChange
  /** L'écart en toutes lettres : « Dégradé : Bon état → État d'usage ». */
  note: string
}

/** Changements qui sont des écarts à relever. */
export const differenceChanges: ReadonlySet<ComparisonChange> = new Set([
  'worse',
  'better',
  'changed',
  'added',
  'missing',
])

export const isDifference = (row: ComparisonRow) => differenceChanges.has(row.change)

type Side = { fields: readonly InspectionField[]; values: InspectionValues }

const levelRank = (value: unknown) =>
  conditionLevelOrder.indexOf(value as InspectionConditionLevel)

function compareField(entryField: InspectionField, exitField: InspectionField, a: unknown, b: unknown) {
  const entry = formatInspectionValue(entryField, a)
  const exit = formatInspectionValue(exitField, b)
  const label = exitField.label
  const base = { fieldId: exitField.id, label, entry, exit }

  const filledA = isFilled(a)
  const filledB = isFilled(b)
  if (!filledA && !filledB) return { ...base, change: 'empty' as const, note: 'Non renseigné' }
  if (!filledA) return { ...base, change: 'added' as const, note: 'Renseigné à la sortie seulement' }
  if (!filledB) return { ...base, change: 'missing' as const, note: 'Non renseigné à la sortie' }

  if (entryField.type === 'condition' && exitField.type === 'condition') {
    const before = levelRank(a)
    const after = levelRank(b)
    if (before >= 0 && after >= 0 && before !== after) {
      const transition = `${conditionLevelLabels[a as InspectionConditionLevel]} → ${conditionLevelLabels[b as InspectionConditionLevel]}`
      return after > before
        ? { ...base, change: 'worse' as const, note: `Dégradé : ${transition}` }
        : { ...base, change: 'better' as const, note: `Amélioré : ${transition}` }
    }
  }

  if (
    entryField.type === 'number' &&
    exitField.type === 'number' &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    a !== b
  ) {
    const delta = b - a
    const unit = exitField.unit ?? entryField.unit
    // Arrondi à l'affichage : 0,1 + 0,2 ne doit pas donner 0,30000000000000004.
    const rounded = Math.round(delta * 1000) / 1000
    const sign = rounded > 0 ? '+' : '−'
    return {
      ...base,
      change: 'changed' as const,
      note: `Écart : ${sign}${formatNumber(Math.abs(rounded))}${unit ? ` ${unit}` : ''}`,
    }
  }

  if (entry === exit && JSON.stringify(a) === JSON.stringify(b)) {
    return { ...base, change: 'same' as const, note: 'Identique' }
  }
  return { ...base, change: 'changed' as const, note: `Changé : ${entry} → ${exit}` }
}

/**
 * Lignes de comparaison, dans l'ordre du modèle de la sortie, suivies des
 * champs que seul le modèle de l'entrée connaissait.
 */
export function compareInspections(entry: Side, exit: Side): ComparisonRow[] {
  const entryFields = new Map(entry.fields.map((field) => [field.id, field]))
  const exitIds = new Set(exit.fields.map((field) => field.id))
  const rows: ComparisonRow[] = []

  for (const exitField of exit.fields) {
    const entryField = entryFields.get(exitField.id)
    const b = exit.values[exitField.id]
    if (!entryField) {
      rows.push({
        fieldId: exitField.id,
        label: exitField.label,
        entry: null,
        exit: formatInspectionValue(exitField, b),
        change: 'exit_only',
        note: 'Champ absent du modèle de l’entrée',
      })
      continue
    }
    rows.push(compareField(entryField, exitField, entry.values[exitField.id], b))
  }

  for (const entryField of entry.fields) {
    if (exitIds.has(entryField.id)) continue
    rows.push({
      fieldId: entryField.id,
      label: entryField.label,
      entry: formatInspectionValue(entryField, entry.values[entryField.id]),
      exit: null,
      change: 'entry_only',
      note: 'Champ absent du modèle de la sortie',
    })
  }
  return rows
}

/** « 2 écarts », « Aucun écart » : le résumé en tête de la comparaison. */
export function differenceSummary(rows: readonly ComparisonRow[]): string {
  const count = rows.filter(isDifference).length
  const worse = rows.filter((row) => row.change === 'worse').length
  if (count === 0) return 'Aucun écart entre l’entrée et la sortie.'
  const total = `${count} écart${count > 1 ? 's' : ''} entre l’entrée et la sortie`
  return worse > 0
    ? `${total}, dont ${worse} dégradation${worse > 1 ? 's' : ''}.`
    : `${total}.`
}
