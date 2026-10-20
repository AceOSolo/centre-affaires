import { mailCategories, type MailCategory } from './categories.ts'

/**
 * Classement du courrier par une personne de l'espace client (ADR 044) : lu,
 * traité, catégorie, étiquettes. Sans base ni framework, éprouvé seul.
 */

export const MAX_TAGS = 10
export const MAX_TAG_LENGTH = 30

/** Classement d'un pli par une personne. Sans ligne : non lu, à traiter, non classé. */
export type MailClassification = {
  readAt: Date | null
  handledAt: Date | null
  category: MailCategory | null
  tags: string[]
}

export const emptyClassification: MailClassification = {
  readAt: null,
  handledAt: null,
  category: null,
  tags: [],
}

/** Une étiquette : espaces resserrés, jamais vide. */
function cleanTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim()
}

const sameTag = (a: string, b: string) => a.toLocaleLowerCase('fr') === b.toLocaleLowerCase('fr')

/** Sans doublon, à la casse près : la première forme saisie l'emporte. */
function uniqueTags(tags: readonly string[]): string[] {
  const kept: string[] = []
  for (const tag of tags) if (!kept.some((other) => sameTag(other, tag))) kept.push(tag)
  return kept
}

/**
 * Étiquettes saisies d'un trait, séparées par des virgules ou des
 * points-virgules : « à payer, comptable ».
 */
export function readTags(input: string): { tags: string[]; error?: undefined } | { tags?: undefined; error: string } {
  const tags = uniqueTags(input.split(/[,;\n]/).map(cleanTag).filter(Boolean))
  if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    return { error: `Une étiquette tient en ${MAX_TAG_LENGTH} caractères au plus.` }
  }
  if (tags.length > MAX_TAGS) return { error: `${MAX_TAGS} étiquettes au plus par courrier.` }
  return { tags }
}

/** Un geste de classement, sur un pli ou sur une sélection. */
export type ClassificationChange =
  | { type: 'read' }
  | { type: 'unread' }
  | { type: 'handled' }
  | { type: 'unhandled' }
  | { type: 'category'; category: MailCategory | null }
  | { type: 'addTag'; tag: string }
  | { type: 'removeTag'; tag: string }
  | { type: 'setTags'; tags: string[] }

/**
 * Le classement après un geste. Marquer traité marque lu : on ne traite pas
 * un courrier sans l'avoir lu. Une étiquette de trop (au-delà de dix) n'est
 * pas ajoutée ; une étiquette déjà présente, à la casse près, non plus.
 */
export function applyClassification(
  current: MailClassification,
  change: ClassificationChange,
  now: Date,
): MailClassification {
  switch (change.type) {
    case 'read':
      return { ...current, readAt: current.readAt ?? now }
    case 'unread':
      return { ...current, readAt: null }
    case 'handled':
      return { ...current, readAt: current.readAt ?? now, handledAt: current.handledAt ?? now }
    case 'unhandled':
      return { ...current, handledAt: null }
    case 'category':
      return { ...current, category: change.category }
    case 'addTag': {
      const tag = cleanTag(change.tag)
      if (!tag || tag.length > MAX_TAG_LENGTH || current.tags.length >= MAX_TAGS) return current
      if (current.tags.some((other) => sameTag(other, tag))) return current
      return { ...current, tags: [...current.tags, tag] }
    }
    case 'removeTag':
      return { ...current, tags: current.tags.filter((other) => !sameTag(other, change.tag)) }
    case 'setTags':
      return { ...current, tags: uniqueTags(change.tags.map(cleanTag).filter(Boolean)).slice(0, MAX_TAGS) }
  }
}

/**
 * Geste de la barre de sélection, lu dans le formulaire : `action` et, selon
 * lui, la catégorie ou l'étiquette choisie.
 */
export function readClassificationChange(
  action: string,
  value: string,
): { change: ClassificationChange; error?: undefined } | { change?: undefined; error: string } {
  switch (action) {
    case 'lu':
      return { change: { type: 'read' } }
    case 'non-lu':
      return { change: { type: 'unread' } }
    case 'traite':
      return { change: { type: 'handled' } }
    case 'a-traiter':
      return { change: { type: 'unhandled' } }
    case 'classer': {
      if (value === 'non-classe') return { change: { type: 'category', category: null } }
      return isMailCategory(value)
        ? { change: { type: 'category', category: value } }
        : { error: 'Choisissez une catégorie.' }
    }
    case 'etiqueter': {
      const tag = cleanTag(value)
      if (!tag) return { error: 'Saisissez l’étiquette à ajouter.' }
      if (tag.length > MAX_TAG_LENGTH) return { error: `Une étiquette tient en ${MAX_TAG_LENGTH} caractères au plus.` }
      return { change: { type: 'addTag', tag } }
    }
    default:
      return { error: 'Choisissez ce que vous voulez faire de la sélection.' }
  }
}

export function isMailCategory(value: string | undefined): value is MailCategory {
  return (mailCategories as readonly string[]).includes(value ?? '')
}

/** Ce que dit la confirmation d'un geste sur une sélection. */
export function classificationDoneMessage(action: string, count: number): string {
  const subject = `${count} courrier${count > 1 ? 's' : ''}`
  const agreed = count > 1 ? 's' : ''
  switch (action) {
    case 'lu':
      return `${subject} marqué${agreed} comme lu${agreed}.`
    case 'non-lu':
      return `${subject} marqué${agreed} comme non lu${agreed}.`
    case 'traite':
      return `${subject} marqué${agreed} comme traité${agreed}.`
    case 'a-traiter':
      return `${subject} remis à traiter.`
    case 'classer':
      return `${subject} classé${agreed}.`
    case 'etiqueter':
      return `Étiquette ajoutée à ${subject}.`
    default:
      return `${subject} mis à jour.`
  }
}

/* -------------------------------------------------------------------------- */
/* Rubriques de la boîte aux lettres                                          */
/* -------------------------------------------------------------------------- */

/** Suivi d'un pli par la personne, tel qu'elle le filtre. */
export const followUpFilters = ['non-lus', 'a-traiter', 'traites'] as const
export type FollowUpFilter = (typeof followUpFilters)[number]

export const followUpLabels: Record<FollowUpFilter, string> = {
  'non-lus': 'Non lus',
  'a-traiter': 'À traiter',
  traites: 'Traités',
}

/** Rubrique : une catégorie, ou les plis non classés. */
export type CategoryFilter = MailCategory | 'non-classe'

export function readCategoryFilter(value: string | undefined): CategoryFilter | undefined {
  if (value === 'non-classe') return value
  return isMailCategory(value) ? value : undefined
}

export function readFollowUpFilter(value: string | undefined): FollowUpFilter | undefined {
  return (followUpFilters as readonly string[]).includes(value ?? '') ? (value as FollowUpFilter) : undefined
}

/** Étiquette filtrée, lue dans l'URL : nettoyée, ou ignorée. */
export function readTagFilter(value: string | undefined): string | undefined {
  const tag = cleanTag(value ?? '')
  return tag && tag.length <= MAX_TAG_LENGTH ? tag : undefined
}
