import {
  resourceStatuses,
  resourceTypes,
  type ResourceAttributes,
  type ResourceStatus,
  type ResourceType,
} from './schema.ts'

/**
 * Saisie d'une ressource et de ses attributs propres au type (R01, décision 2).
 *
 * Une seule description des champs sert à la fois au formulaire et à la
 * validation côté serveur : un champ ajouté ici apparaît à l'écran et se valide
 * de la même façon, sans second endroit à tenir d'accord.
 *
 * La colonne `attributes` est en JSONB : la base accepte n'importe quel objet.
 * C'est donc ici, et seulement ici, que se décide ce qu'un casier ou un véhicule
 * a le droit de porter. Le module est pur — pas de base, pas de `FormData` —
 * pour être éprouvé par `node --test`.
 */

type FieldKind = 'decimal' | 'integer' | 'text' | 'list' | 'choice' | 'plate'

export type AttributeField = {
  name: string
  label: string
  kind: FieldKind
  required?: boolean
  hint?: string
  /** Bornes, comprises, des champs numériques. */
  min?: number
  max?: number
  /** Longueur maximale d'un texte ou d'un élément de liste. */
  maxLength?: number
  /** Valeurs admises d'un champ à choix. */
  choices?: readonly string[]
  placeholder?: string
}

/**
 * Les champs propres à chaque type, dans l'ordre d'affichage.
 *
 * Une boîte aux lettres n'en a aucun : c'est une réponse, pas un oubli.
 */
export const attributeFields: Record<ResourceType, readonly AttributeField[]> = {
  salle: [
    { name: 'superficieM2', label: 'Superficie (m²)', kind: 'decimal', min: 1, max: 100_000 },
    {
      name: 'equipements',
      label: 'Équipements',
      kind: 'list',
      maxLength: 60,
      max: 30,
      hint: 'Séparés par des virgules : visio, écran, paperboard.',
    },
  ],
  bureau: [
    { name: 'superficieM2', label: 'Superficie (m²)', kind: 'decimal', min: 1, max: 100_000 },
    { name: 'postes', label: 'Postes de travail', kind: 'integer', min: 1, max: 500 },
  ],
  casier: [
    {
      name: 'numero',
      label: 'Numéro de casier',
      kind: 'text',
      required: true,
      maxLength: 20,
      hint: 'Celui qui figure sur la porte. Unique parmi les casiers du centre.',
    },
    { name: 'taille', label: 'Taille', kind: 'choice', choices: ['S', 'M', 'L'] },
  ],
  vehicule: [
    {
      name: 'immatriculation',
      label: 'Immatriculation',
      kind: 'plate',
      hint: 'Au format AB-123-CD.',
    },
    { name: 'kilometrage', label: 'Kilométrage', kind: 'integer', min: 0, max: 2_000_000 },
    { name: 'places', label: 'Places', kind: 'integer', min: 1, max: 99 },
  ],
  boite_aux_lettres: [],
}

/** Libellés des champs communs et propres au type, pour le résumé des erreurs. */
export const resourceFieldLabels: Record<string, string> = {
  resourceType: 'Type',
  code: 'Code interne',
  name: 'Nom',
  capacity: 'Capacité',
  status: 'État',
  description: 'Description',
  ...Object.fromEntries(
    Object.values(attributeFields)
      .flat()
      .map((field) => [field.name, field.label]),
  ),
}

/**
 * La capacité compte des personnes : elle n'a pas de sens pour un casier ou une
 * boîte aux lettres, qui la portent toujours à nul (schéma de `resources`).
 */
export function hasCapacity(resourceType: ResourceType): boolean {
  return resourceType !== 'casier' && resourceType !== 'boite_aux_lettres'
}

/** Lecture d'un champ de formulaire, quelle que soit sa source. */
export type FieldReader = (name: string) => string

const formatNumber = (value: number) => value.toLocaleString('fr-FR')

/** « 12,5 » comme « 12.5 », espaces de milliers tolérés. */
function readNumber(raw: string): number | undefined {
  const compact = raw.replace(/[\s  ]/g, '').replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(compact)) return undefined
  return Number(compact)
}

/**
 * Plaque SIV, la seule délivrée depuis 2009 : deux lettres, trois chiffres,
 * deux lettres. Tirets, espaces et minuscules de saisie sont tolérés et
 * normalisés, la plaque est rangée sous une seule forme.
 */
export function normalisePlate(raw: string): string | undefined {
  const compact = raw.toUpperCase().replace(/[\s-]/g, '')
  const match = /^([A-Z]{2})(\d{3})([A-Z]{2})$/.exec(compact)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

type FieldResult = { value?: unknown; error?: string }

function parseField(field: AttributeField, raw: string): FieldResult {
  const text = raw.trim()
  if (!text) return field.required ? { error: 'Ce champ est obligatoire.' } : {}

  switch (field.kind) {
    case 'decimal':
    case 'integer': {
      const value = readNumber(text)
      if (value === undefined) {
        return { error: field.kind === 'integer' ? 'Un nombre entier est attendu.' : 'Un nombre est attendu.' }
      }
      if (field.kind === 'integer' && !Number.isInteger(value)) {
        return { error: 'Un nombre entier est attendu.' }
      }
      if (field.min !== undefined && value < field.min) {
        return { error: `Au moins ${formatNumber(field.min)}.` }
      }
      if (field.max !== undefined && value > field.max) {
        return { error: `Au plus ${formatNumber(field.max)}.` }
      }
      // Deux décimales suffisent à une superficie ; au-delà, c'est du bruit de saisie.
      return { value: field.kind === 'decimal' ? Math.round(value * 100) / 100 : value }
    }
    case 'text': {
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return { error: `${field.maxLength} caractères au plus.` }
      }
      return { value: text }
    }
    case 'plate': {
      const plate = normalisePlate(text)
      return plate ? { value: plate } : { error: 'Immatriculation attendue au format AB-123-CD.' }
    }
    case 'choice': {
      const choice = field.choices?.find((candidate) => candidate === text.toUpperCase())
      return choice
        ? { value: choice }
        : { error: `Valeur attendue : ${(field.choices ?? []).join(', ')}.` }
    }
    case 'list': {
      // Doublons écartés sans tenir compte de la casse : « Wifi » et « wifi »
      // désignent le même équipement.
      const seen = new Set<string>()
      const items: string[] = []
      for (const item of text.split(',').map((part) => part.trim()).filter(Boolean)) {
        if (field.maxLength !== undefined && item.length > field.maxLength) {
          return { error: `Chaque élément fait ${field.maxLength} caractères au plus.` }
        }
        const key = item.toLocaleLowerCase('fr-FR')
        if (seen.has(key)) continue
        seen.add(key)
        items.push(item)
      }
      if (field.max !== undefined && items.length > field.max) {
        return { error: `${field.max} éléments au plus.` }
      }
      return items.length > 0 ? { value: items } : {}
    }
  }
}

export type ParsedAttributes<Type extends ResourceType = ResourceType> = {
  attributes: ResourceAttributes[Type]
  errors: Record<string, string>
}

/**
 * Attributs d'un type, validés.
 *
 * Seuls les champs du type sont retenus : un `postes` envoyé pour une salle est
 * ignoré, pas stocké. Un champ vide et facultatif est absent de l'objet, jamais
 * rangé à `null` — `describeAttributes()` n'a pas à trier des valeurs vides.
 */
export function parseAttributes<Type extends ResourceType>(
  resourceType: Type,
  read: FieldReader,
): ParsedAttributes<Type> {
  const attributes: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const field of attributeFields[resourceType]) {
    const result = parseField(field, read(field.name))
    if (result.error) errors[field.name] = result.error
    else if (result.value !== undefined) attributes[field.name] = result.value
  }

  return { attributes: attributes as ResourceAttributes[Type], errors }
}

/**
 * Attributs à écrire lors d'une modification.
 *
 * Les clés que le formulaire ne connaît pas — posées par un script de reprise
 * ou par une version future — sont conservées : modifier le nom d'une salle ne
 * doit pas effacer ce que l'écran n'affiche pas. Les clés connues, elles,
 * suivent la saisie, y compris quand un champ a été vidé.
 */
export function mergeAttributes(
  resourceType: ResourceType,
  existing: Record<string, unknown> | null | undefined,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const known = new Set(attributeFields[resourceType].map((field) => field.name))
  const kept = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !known.has(key)),
  )
  return { ...kept, ...parsed }
}

export type ResourceInput = {
  resourceType: ResourceType
  code: string
  name: string
  description: string | null
  capacity: number | null
  status: ResourceStatus
  attributes: ResourceAttributes[ResourceType]
}

export type ParsedResource =
  | { ok: true; input: ResourceInput }
  | { ok: false; errors: Record<string, string> }

/**
 * Validation complète d'une saisie de ressource.
 *
 * En modification, le type est imposé par la ressource existante : changer une
 * salle en casier changerait le sens de ses attributs, de sa grille tarifaire et
 * de son annonce. On archive et on en déclare une autre.
 */
export function parseResourceInput(
  read: FieldReader,
  options: { resourceType?: ResourceType; allowedStatuses?: readonly ResourceStatus[] } = {},
): ParsedResource {
  const errors: Record<string, string> = {}

  const rawType = options.resourceType ?? read('resourceType').trim()
  const resourceType = resourceTypes.find((type) => type === rawType)
  if (!resourceType) errors.resourceType = 'Type de ressource inconnu.'

  const code = read('code').trim()
  if (!code) errors.code = 'Le code est obligatoire.'
  else if (code.length > 30) errors.code = '30 caractères au plus.'

  const name = read('name').trim()
  if (!name) errors.name = 'Le nom est obligatoire.'
  else if (name.length > 120) errors.name = '120 caractères au plus.'

  const description = read('description').trim()
  if (description.length > 2000) errors.description = '2 000 caractères au plus.'

  const allowedStatuses = options.allowedStatuses ?? resourceStatuses
  const rawStatus = read('status').trim() || 'active'
  const status = allowedStatuses.find((candidate) => candidate === rawStatus)
  if (!status) errors.status = 'État inconnu.'

  let capacity: number | null = null
  if (resourceType && hasCapacity(resourceType)) {
    const result = parseField(
      { name: 'capacity', label: 'Capacité', kind: 'integer', min: 1, max: 10_000 },
      read('capacity'),
    )
    if (result.error) errors.capacity = result.error
    else capacity = (result.value as number | undefined) ?? null
  }

  const parsed = resourceType ? parseAttributes(resourceType, read) : undefined
  Object.assign(errors, parsed?.errors)

  if (Object.keys(errors).length > 0 || !resourceType || !status || !parsed) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    input: {
      resourceType,
      code,
      name,
      description: description || null,
      capacity,
      status,
      attributes: parsed.attributes,
    },
  }
}

/**
 * Valeur d'un attribut telle que la fiche l'affiche, au format français ;
 * `undefined` quand le champ n'est pas renseigné.
 */
export function formatAttributeValue(field: AttributeField, value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : undefined
  if (typeof value === 'number') return value.toLocaleString('fr-FR')
  return field.kind === 'decimal' || field.kind === 'integer'
    ? Number(value).toLocaleString('fr-FR')
    : String(value)
}

/** Valeur d'un attribut telle qu'un champ de formulaire la réaffiche. */
export function attributeFormValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}
