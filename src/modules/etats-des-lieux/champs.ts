import { conditionLevelLabels, conditionLevelOrder } from './labels.ts'
import type { InspectionField, InspectionFieldType, InspectionValues } from './schema.ts'

/**
 * Règles des modèles d'état des lieux et de leurs valeurs (R06, ADR 039).
 *
 * La base en est la gardienne : `inspection_fields_error()` sur les versions,
 * `inspection_values_error()` dans la garde des états des lieux (migration
 * 0039). Ce module en est le miroir, pour que l'écran dise **toutes** les
 * erreurs, chacune à côté de son champ, avant d'écrire — la base, elle,
 * s'arrête à la première. Les messages sont les siens, mot pour mot :
 * `etats-des-lieux-ecrans.db.test.ts` éprouve l'accord des deux.
 *
 * Module pur : ni base, ni Next.
 */

/** `inspection_fields_error()` : la clé de la valeur dans `inspections.values`. */
export const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
export const MAX_FIELDS = 100
const FIELD_KEYS = new Set(['id', 'label', 'type', 'required', 'unit', 'options', 'help'])
const FIELD_TYPES = new Set<string>(['text', 'number', 'choice', 'checkbox', 'condition'])
export const MAX_TEXT_VALUE = 5000

/** Longueur au sens de Postgres : en caractères, pas en unités UTF-16. */
const length = (value: string) => [...value].length
/** `btrim(text)` de Postgres : les espaces seulement. */
const blank = (value: string) => value.replace(/^ +| +$/g, '') === ''
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const has = (object: Record<string, unknown>, key: string) =>
  Object.hasOwn(object, key) && object[key] !== undefined

export type FieldIssue = {
  /** Rang du champ dans la liste, `null` pour une erreur de la liste entière. */
  index: number | null
  message: string
}

/** Première erreur d'un champ, ou `undefined`. `ids` : identifiants déjà vus. */
function fieldIssue(field: unknown, rank: number, ids: Set<string>): string | undefined {
  if (!isObject(field)) return `Champ n° ${rank} : un objet est attendu.`
  for (const key of Object.keys(field)) {
    if (field[key] !== undefined && !FIELD_KEYS.has(key)) {
      return `Champ n° ${rank} : propriété inconnue « ${key} ».`
    }
  }

  const id = field.id
  if (typeof id !== 'string' || !FIELD_ID_PATTERN.test(id)) {
    return `Champ n° ${rank} : identifiant invalide (une lettre minuscule, puis minuscules, chiffres ou _).`
  }
  if (ids.has(id)) return `Champ « ${id} » : identifiant en double.`
  ids.add(id)

  const label = field.label
  if (typeof label !== 'string' || blank(label) || length(label) > 200) {
    return `Champ « ${id} » : libellé manquant ou de plus de 200 caractères.`
  }

  const type = field.type
  if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
    return `Champ « ${id} » : type inconnu (texte, nombre, choix, case ou note d'état).`
  }

  if (typeof field.required !== 'boolean') return `Champ « ${id} » : dire s'il est obligatoire.`

  if (has(field, 'unit')) {
    if (type !== 'number') return `Champ « ${id} » : seul un nombre a une unité.`
    const unit = field.unit
    if (typeof unit !== 'string' || blank(unit) || length(unit) > 20) {
      return `Champ « ${id} » : unité vide ou de plus de 20 caractères.`
    }
  }

  if (type === 'choice') {
    const options = field.options
    if (!Array.isArray(options)) return `Champ « ${id} » : un choix liste ses options.`
    const seen = new Set<string>()
    for (const option of options) {
      if (typeof option !== 'string' || blank(option) || length(option) > 100) {
        return `Champ « ${id} » : option vide ou de plus de 100 caractères.`
      }
      if (seen.has(option)) return `Champ « ${id} » : option « ${option} » en double.`
      seen.add(option)
    }
    if (seen.size < 2 || seen.size > 50) {
      return `Champ « ${id} » : un choix propose de 2 à 50 options.`
    }
  } else if (has(field, 'options')) {
    return `Champ « ${id} » : seul un choix a des options.`
  }

  if (has(field, 'help')) {
    const help = field.help
    if (typeof help !== 'string' || blank(help) || length(help) > 500) {
      return `Champ « ${id} » : aide vide ou de plus de 500 caractères.`
    }
  }
  return undefined
}

/**
 * Toutes les erreurs d'une liste de champs : la première de chaque champ.
 * Liste vide : la version peut être publiée.
 */
export function inspectionFieldsIssues(fields: unknown): FieldIssue[] {
  if (!Array.isArray(fields)) return [{ index: null, message: 'Le modèle doit être une liste de champs.' }]
  if (fields.length === 0) {
    return [{ index: null, message: 'Le modèle doit compter au moins un champ.' }]
  }
  if (fields.length > MAX_FIELDS) {
    return [{ index: null, message: `Un modèle compte au plus ${MAX_FIELDS} champs.` }]
  }
  const ids = new Set<string>()
  const issues: FieldIssue[] = []
  fields.forEach((field, index) => {
    const message = fieldIssue(field, index + 1, ids)
    if (message) issues.push({ index, message })
  })
  return issues
}

/** Miroir de `inspection_fields_error()` : la première erreur, ou `null`. */
export function inspectionFieldsError(fields: unknown): string | null {
  return inspectionFieldsIssues(fields)[0]?.message ?? null
}

/* -------------------------------------------------------------------------- */
/* Valeurs                                                                    */
/* -------------------------------------------------------------------------- */

export type ValueIssue = {
  /** Champ en cause, `null` pour une erreur de l'objet entier. */
  fieldId: string | null
  message: string
}

/** Une valeur est-elle renseignée, au sens de la clôture ? */
export function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return !blank(value)
  return true
}

function valueIssue(field: InspectionField, value: unknown): string | undefined {
  const label = field.label
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string' || length(value) > MAX_TEXT_VALUE) {
        return `« ${label} » : un texte de 5 000 caractères au plus est attendu.`
      }
      return undefined
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `« ${label} » : un nombre est attendu.`
      }
      return undefined
    case 'choice':
      if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
        return `« ${label} » : choisissez l'une des options proposées.`
      }
      return undefined
    case 'checkbox':
      if (typeof value !== 'boolean') return `« ${label} » : coché ou non coché.`
      return undefined
    case 'condition':
      if (typeof value !== 'string' || !(conditionLevelOrder as string[]).includes(value)) {
        return `« ${label} » : une note d'état est attendue (neuf, bon, usage, mauvais).`
      }
      return undefined
    default:
      return `« ${label} » : type de champ inconnu.`
  }
}

/**
 * Toutes les erreurs des valeurs d'un état des lieux face à sa version de
 * modèle. Avec `complete` (clôture), chaque champ obligatoire doit être
 * renseigné. Miroir de `inspection_values_error()`.
 */
export function inspectionValuesIssues(
  fields: readonly InspectionField[],
  values: unknown,
  complete: boolean,
): ValueIssue[] {
  if (!isObject(values)) {
    return [
      {
        fieldId: null,
        message: "Les valeurs d'un état des lieux forment un objet, par identifiant de champ.",
      },
    ]
  }
  const byId = new Map(fields.map((field) => [field.id, field]))
  const issues: ValueIssue[] = []
  for (const [key, value] of Object.entries(values)) {
    const field = byId.get(key)
    if (!field) {
      issues.push({
        fieldId: key,
        message: `Valeur pour un champ que le modèle ne connaît pas : « ${key} ».`,
      })
      continue
    }
    if (value === null || value === undefined) continue
    const message = valueIssue(field, value)
    if (message) issues.push({ fieldId: key, message })
  }
  if (complete) {
    for (const field of fields) {
      if (!field.required || isFilled(values[field.id])) continue
      if (issues.some((issue) => issue.fieldId === field.id)) continue
      issues.push({
        fieldId: field.id,
        message: `« ${field.label} » est obligatoire : renseignez-le avant de clore.`,
      })
    }
  }
  return issues
}

/** Miroir de `inspection_values_error()` : la première erreur, ou `null`. */
export function inspectionValuesError(
  fields: readonly InspectionField[],
  values: unknown,
  complete: boolean,
): string | null {
  return inspectionValuesIssues(fields, values, complete)[0]?.message ?? null
}

/* -------------------------------------------------------------------------- */
/* Formulaire de saisie                                                       */
/* -------------------------------------------------------------------------- */

/** Nom (et identifiant HTML) du contrôle d'un champ : `v_<id>`. */
export const valueInputName = (fieldId: string) => `v_${fieldId}`

/**
 * Nombre saisi à la française : « 12 345,5 », « 12345.5 », « -3 ». Espaces
 * (y compris insécables) ignorés, virgule ou point décimal. `undefined` si
 * illisible.
 */
export function parseFrenchNumber(raw: string): number | undefined {
  const compact = raw.replace(/[\s  ]/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(compact)) return undefined
  const value = Number(compact)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Lit les valeurs d'un formulaire généré depuis une version de modèle.
 *
 * Un champ vide vaut « non renseigné » (`null`). Le texte est débarrassé de
 * ses espaces de bord. La case « oui ou non » se saisit par deux boutons
 * radio : rien de coché vaut « non renseigné », pas « non » — un état des
 * lieux dit ce qui a été constaté.
 *
 * Rend les valeurs et les erreurs, par identifiant de champ. Les champs
 * obligatoires ne sont pas exigés ici : c'est la clôture qui les exige
 * (`inspectionValuesIssues(…, true)`).
 */
export function readInspectionValues(
  fields: readonly InspectionField[],
  get: (name: string) => string | null | undefined,
): { values: InspectionValues; errors: Record<string, string> } {
  const values: InspectionValues = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const raw = (get(valueInputName(field.id)) ?? '').trim()
    if (raw === '') {
      values[field.id] = null
      continue
    }
    switch (field.type) {
      case 'text':
        values[field.id] = raw
        if (length(raw) > MAX_TEXT_VALUE) errors[field.id] = 'Ce texte dépasse 5 000 caractères.'
        break
      case 'number': {
        const number = parseFrenchNumber(raw)
        if (number === undefined) {
          values[field.id] = null
          errors[field.id] = 'Indiquez un nombre, par exemple 12 345 ou 12,5.'
        } else {
          values[field.id] = number
        }
        break
      }
      case 'choice':
        if ((field.options ?? []).includes(raw)) values[field.id] = raw
        else {
          values[field.id] = null
          errors[field.id] = 'Choisissez l’une des options proposées.'
        }
        break
      case 'checkbox':
        if (raw === 'oui' || raw === 'non') values[field.id] = raw === 'oui'
        else {
          values[field.id] = null
          errors[field.id] = 'Répondez par oui ou par non.'
        }
        break
      case 'condition':
        if ((conditionLevelOrder as string[]).includes(raw)) values[field.id] = raw
        else {
          values[field.id] = null
          errors[field.id] = 'Choisissez une note d’état.'
        }
        break
    }
  }
  return { values, errors }
}

/** Valeur telle que le formulaire la reprend (`defaultValue`, bouton coché). */
export function valueToInput(field: InspectionField, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (field.type === 'checkbox') return value === true ? 'oui' : value === false ? 'non' : ''
  if (field.type === 'number' && typeof value === 'number') return formatNumber(value)
  return String(value)
}

const numberFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 })

/** « 12 345,5 » : séparateurs français. */
export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

/**
 * Valeur lisible d'un champ, `null` si non renseignée. Le libellé d'une note
 * d'état, l'unité d'un nombre, « Oui » ou « Non ».
 */
export function formatInspectionValue(field: Pick<InspectionField, 'type' | 'unit'>, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (field.type) {
    case 'number':
      return typeof value === 'number'
        ? `${formatNumber(value)}${field.unit ? ` ${field.unit}` : ''}`
        : String(value)
    case 'checkbox':
      return value === true ? 'Oui' : value === false ? 'Non' : String(value)
    case 'condition':
      return conditionLevelLabels[value as keyof typeof conditionLevelLabels] ?? String(value)
    default:
      return typeof value === 'string' && blank(value) ? null : String(value)
  }
}

/* -------------------------------------------------------------------------- */
/* Édition d'un modèle                                                        */
/* -------------------------------------------------------------------------- */

/** Un champ tel que l'éditeur le rend : chaînes brutes, avant normalisation. */
export type EditorField = {
  /** Identifiant d'un champ déjà publié ; vide pour un champ ajouté. */
  id: string
  label: string
  type: string
  required: boolean
  unit: string
  /** Une option par ligne. */
  options: string
  help: string
}

/**
 * Identifiant tiré d'un libellé : « Niveau de carburant » → `niveau_de_carburant`.
 * Sans accents, en minuscules, 63 caractères au plus, unique parmi `taken`
 * (suffixe `_2`, `_3`…). Il ne change plus ensuite : la comparaison d'une
 * sortie à son entrée rapproche les champs par lui, d'une version à l'autre.
 */
export function fieldIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(base)) base = `champ${base ? `_${base}` : ''}`
  base = base.slice(0, 58).replace(/_+$/, '')
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`
  return id
}

/**
 * Champs saisis dans l'éditeur → champs d'une version : espaces de bord
 * retirés, propriétés vides omises, unité gardée pour un nombre seulement,
 * options pour un choix seulement, identifiant donné aux champs ajoutés.
 */
export function normalizeEditorFields(rows: readonly EditorField[]): InspectionField[] {
  const taken = new Set(rows.map((row) => row.id.trim()).filter(Boolean))
  return rows.map((row) => {
    const label = row.label.trim()
    const type = row.type as InspectionFieldType
    let id = row.id.trim()
    if (!id) {
      id = fieldIdFromLabel(label || 'champ', taken)
      taken.add(id)
    }
    const field: InspectionField = { id, label, type, required: Boolean(row.required) }
    const unit = row.unit.trim()
    if (type === 'number' && unit) field.unit = unit
    if (type === 'choice') {
      field.options = row.options
        .split(/\r?\n/)
        .map((option) => option.trim())
        .filter(Boolean)
    }
    const help = row.help.trim()
    if (help) field.help = help
    return field
  })
}

/** Le pendant de `normalizeEditorFields`, pour ouvrir une version dans l'éditeur. */
export function toEditorFields(fields: readonly InspectionField[]): EditorField[] {
  return fields.map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    unit: field.unit ?? '',
    options: (field.options ?? []).join('\n'),
    help: field.help ?? '',
  }))
}

/**
 * Deux listes de champs identiques ? Une publication sans changement ne crée
 * pas de version : « nouvelle version à chaque modification ».
 */
export function sameFields(a: readonly InspectionField[], b: readonly InspectionField[]): boolean {
  const canonical = (fields: readonly InspectionField[]) =>
    JSON.stringify(
      fields.map((field) => [
        field.id,
        field.label,
        field.type,
        field.required,
        field.unit ?? null,
        field.options ?? null,
        field.help ?? null,
      ]),
    )
  return canonical(a) === canonical(b)
}
