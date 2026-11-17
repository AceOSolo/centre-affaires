import { notificationCategories, type NotificationCategory } from './schema.ts'

/**
 * Préférences de messages rangées par service (ADR 077, recette du 17/11) :
 * le client voit ses réglages sous les services qu'il utilise — le courrier
 * s'il est domicilié, les réservations s'il en a, ses contrats, ses
 * factures —, et seulement ceux-là.
 *
 * Un groupe caché garde ses réglages : la page n'enregistre que les cases
 * qu'elle montre (`mergeShownPreferences`). Une catégorie jamais réglée est
 * reçue (pas de ligne : tout est reçu, ADR 038) ; le premier courrier ou la
 * première réservation arrive donc par courriel avant que le groupe ne
 * paraisse ici.
 *
 * Module pur : la page, le formulaire et les tests s'en servent.
 */

/** Ce que l'entreprise utilise, tel que l'espace le sait (`espace.ts`). */
export type PreferenceUsage = {
  domiciliated: boolean
  bookings: number
  contracts: number
  inspections: number
  invoices: number
}

export type PreferenceGroup = {
  key: string
  title: string
  /** Une phrase sous le titre : de quoi parlent ces messages. */
  description: string
  categories: readonly NotificationCategory[]
}

type GroupRule = PreferenceGroup & { shown: (usage: PreferenceUsage) => boolean }

/** Dans l'ordre des rubriques de l'espace ; « Informations du centre » pour tous, en dernier. */
const groups: readonly GroupRule[] = [
  {
    key: 'courrier',
    title: 'Courrier',
    description: 'Votre domiciliation : les plis reçus à votre nom et la suite donnée à vos demandes.',
    categories: ['mail', 'mail_none'],
    shown: (usage) => usage.domiciliated,
  },
  {
    key: 'reservations',
    title: 'Réservations',
    description: 'Vos salles, bureaux, camion et matériel réservés.',
    categories: ['bookings'],
    shown: (usage) => usage.bookings > 0,
  },
  {
    key: 'contrats',
    title: 'Contrats',
    description: 'Vos contrats avec le centre.',
    categories: ['contracts'],
    shown: (usage) => usage.contracts > 0,
  },
  {
    key: 'etats-des-lieux',
    title: 'États des lieux',
    description: 'Entrées et sorties des locaux ou du véhicule loués.',
    categories: ['inspections'],
    shown: (usage) => usage.inspections > 0,
  },
  {
    key: 'factures',
    title: 'Factures',
    description: 'Les documents de facturation déposés dans votre espace.',
    categories: ['invoices'],
    shown: (usage) => usage.invoices > 0,
  },
  {
    key: 'centre',
    title: 'Informations du centre',
    description: 'Les messages de l’équipe à tous ses clients.',
    categories: ['centre_info'],
    shown: () => true,
  },
]

/** Tous les groupes, dans l'ordre : chaque catégorie dans un seul (`preferences-groupes.test.ts`). */
export const preferenceGroups: readonly PreferenceGroup[] = groups.map(({ shown: _shown, ...group }) => group)

/** Les groupes utiles à cette entreprise. */
export function visiblePreferenceGroups(usage: PreferenceUsage): PreferenceGroup[] {
  return groups.filter((group) => group.shown(usage)).map(({ shown: _shown, ...group }) => group)
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (notificationCategories as readonly string[]).includes(value)
}

type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] }

/**
 * Préférences à enregistrer : les cases montrées (`categorie`, champs cachés)
 * prennent la valeur du formulaire — cochée ou non —, les autres gardent la
 * leur. Une catégorie inconnue est ignorée.
 */
export function mergeShownPreferences(
  current: Record<NotificationCategory, boolean>,
  form: FormLike,
): Record<NotificationCategory, boolean> {
  const shown = new Set(form.getAll('categorie').filter(isNotificationCategory))
  return Object.fromEntries(
    notificationCategories.map((category) => [
      category,
      shown.has(category) ? form.get(category) === 'on' : current[category],
    ]),
  ) as Record<NotificationCategory, boolean>
}
