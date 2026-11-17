import { mailCategories, type MailCategory } from './categories.ts'
import { MAX_CUSTOM_CATEGORY_LENGTH, cleanCategoryName, sameCategoryName } from './categories-perso-regles.ts'
import { mailCategoryLabels } from './labels.ts'

/**
 * Catégories du courrier telles qu'on les règle (ADR 078) : la liste proposée
 * par le centre — renommée, masquée, ordonnée dans Réglages —, puis la vue de
 * chaque personne, qui renomme, masque et ordonne pour elle seule les
 * catégories proposées comme les siennes (ADR 060). Le centre garde ses
 * catégories intactes : la personne ne change que sa vue.
 *
 * Sans base ni framework, éprouvé seul (`categories-reglages-regles.test.ts`).
 *
 * Masquer une catégorie la retire des listes de classement et des rubriques
 * tant qu'elle est vide ; un pli déjà rangé y reste, la rubrique reparaît
 * avec lui, et la fiche du pli garde son choix.
 */

/** Réglage du centre pour une catégorie proposée : une ligne de `mail_category_defaults`. */
export type CentreCategorySetting = {
  category: MailCategory
  name: string | null
  hidden: boolean
  position: number | null
}

/** Une catégorie proposée, telle que le centre la propose. */
export type ProposedCategory = {
  category: MailCategory
  /** Nom du code (`labels.ts`), celui que « Rétablir » remet. */
  codeName: string
  name: string
  hidden: boolean
}

/** Rang de départ d'une catégorie proposée : son rang dans le code. */
const codeRank = (category: MailCategory) => mailCategories.indexOf(category)

/**
 * Les catégories proposées par le centre, dans son ordre : ses réglages, sinon
 * le nom et le rang du code. Une catégorie sans réglage garde sa place.
 */
export function centreCategories(settings: readonly CentreCategorySetting[]): ProposedCategory[] {
  const byCategory = new Map(settings.map((setting) => [setting.category, setting]))
  return [...mailCategories]
    .map((category) => {
      const setting = byCategory.get(category)
      return {
        category,
        codeName: mailCategoryLabels[category],
        name: setting?.name ?? mailCategoryLabels[category],
        hidden: setting?.hidden ?? false,
        rank: setting?.position ?? codeRank(category),
      }
    })
    .sort((a, b) => a.rank - b.rank || codeRank(a.category) - codeRank(b.category))
    .map(({ rank: _rank, ...entry }) => entry)
}

/** Réglage d'une personne pour une catégorie proposée : nul, comme le centre. */
export type PersonCategoryPref = {
  category: MailCategory
  name: string | null
  hidden: boolean | null
  position: number | null
}

/** Une catégorie personnelle (ADR 060), avec son rang et son masquage. */
export type OwnCategory = {
  id: string
  name: string
  hidden: boolean
  position: number | null
}

/** Une catégorie de la liste d'une personne : proposée ou à elle. */
export type CategoryEntry = {
  /** Clé de départ (`impots`), ou identifiant d'une catégorie personnelle. */
  key: string
  kind: 'proposee' | 'perso'
  name: string
  /** Nom proposé par le centre, que « Rétablir » remet ; nul pour une catégorie personnelle. */
  centreName: string | null
  hidden: boolean
}

/** Rang de départ d'une catégorie personnelle : après toutes les proposées. */
const OWN_RANK = 10_000

/**
 * La liste d'une personne : les catégories proposées, avec ses réglages, puis
 * les siennes. Un rang posé par la personne l'emporte ; sinon, les proposées
 * dans l'ordre du centre, puis les siennes par ordre alphabétique. Une
 * catégorie créée après un rangement arrive donc en fin de liste.
 */
export function personCategoryList(
  centre: readonly ProposedCategory[],
  prefs: readonly PersonCategoryPref[],
  own: readonly OwnCategory[],
): CategoryEntry[] {
  const byCategory = new Map(prefs.map((pref) => [pref.category, pref]))
  const alphabetical = [...own].sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id))
  const ranked = [
    ...centre.map((entry, index) => {
      const pref = byCategory.get(entry.category)
      return {
        rank: pref?.position ?? index,
        kind: 0,
        entry: {
          key: entry.category,
          kind: 'proposee' as const,
          name: pref?.name ?? entry.name,
          centreName: entry.name,
          hidden: pref?.hidden ?? entry.hidden,
        },
      }
    }),
    ...alphabetical.map((category, index) => ({
      rank: category.position ?? OWN_RANK + index,
      kind: 1,
      entry: { key: category.id, kind: 'perso' as const, name: category.name, centreName: null, hidden: category.hidden },
    })),
  ]
  return ranked.sort((a, b) => a.rank - b.rank || a.kind - b.kind).map(({ entry }) => entry)
}

/** Déplace une catégorie d'un cran vers le haut ou le bas ; inchangé aux bords. */
export function moveKey(keys: readonly string[], key: string, direction: 'haut' | 'bas'): string[] {
  const index = keys.indexOf(key)
  const target = direction === 'haut' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= keys.length) return [...keys]
  const next = [...keys]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** « impots:haut » : le bouton de déplacement pressé, lu dans le formulaire. */
export function readMove(value: string | null | undefined): { key: string; direction: 'haut' | 'bas' } | undefined {
  const match = /^(.+):(haut|bas)$/.exec(value ?? '')
  return match ? { key: match[1], direction: match[2] as 'haut' | 'bas' } : undefined
}

/** Ce que l'écran envoie pour une catégorie : son nom saisi et sa case « masquée ». */
export type CategoryInput = { key: string; name: string; hidden: boolean }

/** Ce qu'il faut d'un `FormData` pour lire la liste : de quoi l'éprouver sans navigateur. */
type FormFields = { get(name: string): unknown; getAll(name: string): unknown[] }

/** Le geste qui a envoyé la liste : enregistrer, déplacer une catégorie, ou rétablir un nom. */
export type CategoryListGesture =
  | { type: 'enregistrer' }
  | { type: 'deplacer'; key: string; direction: 'haut' | 'bas' }
  | { type: 'retablir'; key: string }

/**
 * Lit la liste envoyée par l'écran des catégories : l'ordre affiché (`ordre`,
 * un champ caché par ligne), puis pour chaque clé son nom (`nom-<clé>`), sa
 * case « Masquer » (`masquee-<clé>`) et son nom d'origine (`origine-<clé>`,
 * pour « Rétablir »). Le bouton pressé dit le geste ; le déplacement et le
 * rétablissement s'appliquent à la liste rendue, avec les autres saisies.
 */
export function readCategoryListForm(form: FormFields): {
  inputs: CategoryInput[]
  gesture: CategoryListGesture
  /** Saisies brutes, rendues au formulaire en cas d'erreur. */
  values: Record<string, string>
} {
  const text = (name: string) => {
    const value = form.get(name)
    return typeof value === 'string' ? value : ''
  }
  const keys = [...new Set(form.getAll('ordre').filter((key): key is string => typeof key === 'string' && key !== ''))]
  const values: Record<string, string> = {}
  let inputs = keys.map((key) => {
    values[`nom-${key}`] = text(`nom-${key}`)
    if (text(`masquee-${key}`) === 'on') values[`masquee-${key}`] = 'on'
    return { key, name: text(`nom-${key}`), hidden: text(`masquee-${key}`) === 'on' }
  })
  const move = readMove(text('deplacer'))
  const restore = text('retablir')
  let gesture: CategoryListGesture = { type: 'enregistrer' }
  if (move && keys.includes(move.key)) {
    gesture = { type: 'deplacer', ...move }
    const order = moveKey(keys, move.key, move.direction)
    inputs = order.map((key) => inputs.find((input) => input.key === key) as CategoryInput)
  } else if (restore && keys.includes(restore) && text(`origine-${restore}`)) {
    gesture = { type: 'retablir', key: restore }
    inputs = inputs.map((input) => (input.key === restore ? { ...input, name: text(`origine-${restore}`) } : input))
    values[`nom-${restore}`] = text(`origine-${restore}`)
  }
  return { inputs, gesture, values }
}

/** Ce que dit l'écran après un geste réussi. */
export function categoryListDoneMessage(gesture: CategoryListGesture, inputs: readonly CategoryInput[]): string {
  const name = (key: string) => cleanCategoryName(inputs.find((input) => input.key === key)?.name ?? '')
  switch (gesture.type) {
    case 'deplacer': {
      const rank = inputs.findIndex((input) => input.key === gesture.key) + 1
      return `« ${name(gesture.key)} » déplacée en position ${rank} sur ${inputs.length}.`
    }
    case 'retablir':
      return `Nom d’origine rétabli : « ${name(gesture.key)} ».`
    default:
      return 'Catégories enregistrées.'
  }
}

/** Noms réservés dans toute liste : la rubrique des plis sans catégorie. */
const UNCLASSIFIED = ['Non classé', 'Non classe']

/**
 * Vérifie les noms d'une liste : chacun non vide, 40 caractères au plus,
 * distinct des autres à la casse près, jamais « Non classé ». Rend les noms
 * nettoyés, ou une erreur par champ (`nom-<clé>`, l'`id` du champ).
 */
export function validateCategoryInputs(
  inputs: readonly CategoryInput[],
): { entries: CategoryInput[]; fieldErrors?: undefined } | { entries?: undefined; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {}
  const entries = inputs.map((input) => ({ ...input, name: cleanCategoryName(input.name) }))
  entries.forEach((entry, index) => {
    const field = `nom-${entry.key}`
    if (entry.name === '') fieldErrors[field] = 'Saisissez un nom.'
    else if (entry.name.length > MAX_CUSTOM_CATEGORY_LENGTH) {
      fieldErrors[field] = `${MAX_CUSTOM_CATEGORY_LENGTH} caractères au plus (${entry.name.length}).`
    } else if (UNCLASSIFIED.some((reserved) => sameCategoryName(reserved, entry.name))) {
      fieldErrors[field] = '« Non classé » désigne déjà les courriers sans catégorie.'
    } else {
      const twin = entries.findIndex((other, otherIndex) => otherIndex !== index && sameCategoryName(other.name, entry.name))
      if (twin >= 0) fieldErrors[field] = `Deux catégories s’appellent « ${entry.name} » : donnez-leur des noms distincts.`
    }
  })
  return Object.keys(fieldErrors).length > 0 ? { fieldErrors } : { entries }
}

/** Ce qu'une personne enregistre : ses réglages des catégories proposées, et les siennes. */
export type PersonCategoriesSave = {
  /** Une ligne par catégorie proposée ; toute valeur nulle suit le centre. */
  prefs: PersonCategoryPref[]
  own: OwnCategory[]
}

/**
 * Traduit la liste saisie par une personne (dans l'ordre affiché) en
 * réglages : un nom ou un masquage n'est gardé que s'il diffère de celui du
 * centre ; les rangs ne sont posés que si l'ordre diffère de l'ordre de
 * départ — sinon un changement d'ordre du centre ne lui parviendrait plus.
 */
export function personCategoriesSave(
  centre: readonly ProposedCategory[],
  own: readonly OwnCategory[],
  inputs: readonly CategoryInput[],
): PersonCategoriesSave {
  const byKey = new Map(inputs.map((input, index) => [input.key, { ...input, index }]))
  const startingOrder = personCategoryList(
    centre,
    [],
    own.map((category) => ({ ...category, position: null })),
  ).map((entry) => entry.key)
  const ordered = inputs.map((input) => input.key)
  const keepOrder = startingOrder.length === ordered.length && startingOrder.every((key, index) => ordered[index] === key)
  const rank = (key: string, fallback: number | null) => {
    const input = byKey.get(key)
    if (!input) return fallback
    return keepOrder ? null : input.index
  }
  return {
    prefs: centre.map((entry) => {
      const input = byKey.get(entry.category)
      const name = input ? cleanCategoryName(input.name) : entry.name
      const hidden = input ? input.hidden : entry.hidden
      return {
        category: entry.category,
        name: name === entry.name ? null : name,
        hidden: hidden === entry.hidden ? null : hidden,
        position: rank(entry.category, null),
      }
    }),
    own: own.map((category) => {
      const input = byKey.get(category.id)
      return {
        id: category.id,
        name: input ? cleanCategoryName(input.name) : category.name,
        hidden: input ? input.hidden : category.hidden,
        position: rank(category.id, category.position),
      }
    }),
  }
}

/**
 * Ce que le centre enregistre : un nom gardé s'il diffère de celui du code,
 * des rangs posés si l'ordre diffère de celui du code.
 */
export function centreCategoriesSave(inputs: readonly CategoryInput[]): CentreCategorySetting[] {
  const ordered = inputs.map((input) => input.key)
  const keepOrder = ordered.length === mailCategories.length && mailCategories.every((key, index) => ordered[index] === key)
  return inputs
    .filter((input): input is CategoryInput & { key: MailCategory } =>
      (mailCategories as readonly string[]).includes(input.key),
    )
    .map((input, index) => {
      const name = cleanCategoryName(input.name)
      return {
        category: input.key,
        name: name === mailCategoryLabels[input.key] ? null : name,
        hidden: input.hidden,
        position: keepOrder ? null : index,
      }
    })
}

/**
 * Les catégories que l'on propose pour ranger un pli : celles qui ne sont pas
 * masquées, et celle où il est déjà rangé, même masquée.
 */
export function classifiableCategories(entries: readonly CategoryEntry[], current?: string | null): CategoryEntry[] {
  return entries.filter((entry) => !entry.hidden || entry.key === current)
}

/** Nom d'une rubrique dans la liste de la personne : celui qu'elle lui a donné, ou rien. */
export function categoryLabel(
  classification: { category: MailCategory | null; customCategoryId: string | null },
  entries: readonly CategoryEntry[],
): string | null {
  const key = classification.customCategoryId ?? classification.category
  if (!key) return null
  return (
    entries.find((entry) => entry.key === key)?.name ??
    (classification.category ? mailCategoryLabels[classification.category] : null)
  )
}
