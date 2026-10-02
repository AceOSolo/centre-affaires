import type { Tenant } from '../../db/tenants.ts'

/**
 * Durées de conservation du centre (R29, ADR 015, 020, 038, 039, 040) : ce
 * que l'écran de configuration règle, et ce qu'il rappelle de chacune.
 *
 * Module pur, sans base ni Next : chargé aussi par le formulaire, côté
 * navigateur. Les bornes reprennent les contraintes de `tenants`
 * (`tenants_*_retention_valid` : de 1 à 120 mois), qui restent l'autorité.
 *
 * Le tableau de référence est `docs/rgpd/durees-de-conservation.md` : un
 * libellé, un départ ou un statut qui change ici change là-bas.
 */

/** Colonnes de `tenants` qui portent une durée de conservation, en mois. */
export const retentionKeys = [
  'prospectRetentionMonths',
  'clientRetentionMonths',
  'removedMemberRetentionMonths',
  'mailScanRetentionMonths',
  'mailAccessLogRetentionMonths',
  'publicRequestRetentionMonths',
  'notificationLogRetentionMonths',
  'inspectionPhotoRetentionMonths',
  'inspectionAccessLogRetentionMonths',
] as const

export type RetentionKey = (typeof retentionKeys)[number]

export type RetentionDurations = Record<RetentionKey, number>

/** Bornes des contraintes de `tenants`. */
export const RETENTION_MIN_MONTHS = 1
export const RETENTION_MAX_MONTHS = 120

export type RetentionGroup = 'clients' | 'courrier' | 'reservations' | 'notifications' | 'etats-des-lieux'

export const retentionGroupLabels: Record<RetentionGroup, string> = {
  clients: 'Clients, prospects et personnes retirées',
  courrier: 'Courrier',
  reservations: 'Demandes de réservation',
  notifications: 'Messages envoyés',
  'etats-des-lieux': 'États des lieux',
}

export type RetentionDuration = {
  key: RetentionKey
  group: RetentionGroup
  /** Libellé du champ, aussi repris par le résumé d'erreurs. */
  label: string
  /** D'où part le délai. */
  start: string
  /** Ce qui se passe au terme. */
  effect: string
  /** Valeur par défaut de la colonne. */
  defaultMonths: number
  /** Décision du centre : une durée proposée reste « à valider » tant qu'il ne l'a pas validée. */
  status: string
}

/**
 * Les neuf durées, dans l'ordre de l'écran. Les défauts sont ceux des
 * colonnes de `tenants` (migrations 0024, 0026, 0043).
 */
export const retentionDurations: readonly RetentionDuration[] = [
  {
    key: 'prospectRetentionMonths',
    group: 'clients',
    label: 'Prospect sans suite',
    start: 'Depuis la dernière activité du prospect : création de la fiche, dernier contact noté, réservation, courrier.',
    effect:
      'La fiche est anonymisée par la tâche de nuit : raison sociale, coordonnées, notes, contacts et accès effacés. Jamais tant qu’une exclusion demeure.',
    defaultMonths: 36,
    status: 'à valider',
  },
  {
    key: 'clientRetentionMonths',
    group: 'clients',
    label: 'Client, après la fin de la relation',
    start:
      'Depuis la dernière activité du client : fin du dernier contrat, dernière réservation, dernier pli, dernière facture ou dernier paiement.',
    effect:
      'Même anonymisation que pour un prospect, plis et demandes de courrier compris. Les factures émises, leurs lignes et les paiements ne sont jamais touchés : ils se gardent 10 ans (art. L.123-22 du Code de commerce). 5 ans : prescription commerciale (art. L.110-4).',
    defaultMonths: 60,
    status: 'à valider',
  },
  {
    key: 'removedMemberRetentionMonths',
    group: 'clients',
    label: 'Accès client ou membre de l’équipe retiré',
    start: 'Depuis le retrait de l’accès à l’espace client, ou du membre de l’équipe.',
    effect:
      'Nom et adresse effacés, compte détaché. La ligne reste : elle signe des demandes, des ouvertures, des consultations.',
    defaultMonths: 12,
    status: 'à valider',
  },
  {
    key: 'mailScanRetentionMonths',
    group: 'courrier',
    label: 'Numérisations de courrier',
    start: 'Depuis le dépôt de la numérisation.',
    effect:
      'Le fichier est effacé du stockage. Le pli reste, avec ses dates et son ouverture, au relevé de facturation.',
    defaultMonths: 12,
    status: 'validée le 30/09/2026',
  },
  {
    key: 'mailAccessLogRetentionMonths',
    group: 'courrier',
    label: 'Journal des consultations du courrier',
    start: 'Depuis la consultation.',
    effect: 'Les lignes du journal sont effacées.',
    defaultMonths: 12,
    status: 'validée le 30/09/2026',
  },
  {
    key: 'publicRequestRetentionMonths',
    group: 'reservations',
    label: 'Coordonnées des demandeurs du site public',
    start: 'Depuis la fin du créneau demandé, ou l’annulation si elle précède.',
    effect: 'Nom, adresse et téléphone du demandeur effacés. La réservation reste.',
    defaultMonths: 12,
    status: 'à valider',
  },
  {
    key: 'notificationLogRetentionMonths',
    group: 'notifications',
    label: 'Journal des messages envoyés',
    start: 'Depuis l’envoi du message.',
    effect: 'Les lignes du journal (destinataires, objet, statut) sont effacées.',
    defaultMonths: 12,
    status: 'à valider',
  },
  {
    key: 'inspectionPhotoRetentionMonths',
    group: 'etats-des-lieux',
    label: 'Photos des états des lieux',
    start:
      'Depuis la clôture de l’état des lieux de sortie. Une entrée sans sortie close n’est jamais purgée.',
    effect:
      'Le fichier de la photo est effacé du stockage ; l’état des lieux et ses valeurs restent. Trop court, la preuve manque en cas de litige sur le dépôt de garantie.',
    defaultMonths: 36,
    status: 'à valider',
  },
  {
    key: 'inspectionAccessLogRetentionMonths',
    group: 'etats-des-lieux',
    label: 'Journal des consultations des photos',
    start: 'Depuis la consultation.',
    effect: 'Les lignes du journal sont effacées.',
    defaultMonths: 12,
    status: 'à valider',
  },
]

/** Libellés des champs, pour le résumé d'erreurs. */
export const retentionLabels: Record<string, string> = Object.fromEntries(
  retentionDurations.map((duration) => [duration.key, duration.label]),
)

/** Saisie brute du formulaire : nom du champ → valeur texte. */
export type RetentionInput = Record<string, string | undefined>

export type RetentionResult =
  | { ok: true; update: RetentionDurations }
  | { ok: false; fieldErrors: Partial<Record<RetentionKey, string>> }

const BOUNDS_MESSAGE = `Un nombre entier de mois, de ${RETENTION_MIN_MONTHS} à ${RETENTION_MAX_MONTHS} (10 ans).`

/**
 * Lit les neuf durées. Tout ou rien : une durée illisible ou hors bornes
 * refuse l'enregistrement, avec un message par champ.
 */
export function parseRetentionDurations(input: RetentionInput): RetentionResult {
  const fieldErrors: Partial<Record<RetentionKey, string>> = {}
  const update = {} as RetentionDurations
  for (const key of retentionKeys) {
    const value = (input[key] ?? '').trim()
    const months = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN
    if (!Number.isInteger(months) || months < RETENTION_MIN_MONTHS || months > RETENTION_MAX_MONTHS) {
      fieldErrors[key] = BOUNDS_MESSAGE
    } else {
      update[key] = months
    }
  }
  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, update }
}

/** Les durées du centre, mises en forme pour les champs. */
export function retentionValues(tenant: Pick<Tenant, RetentionKey>): Record<RetentionKey, string> {
  return Object.fromEntries(retentionKeys.map((key) => [key, String(tenant[key])])) as Record<
    RetentionKey,
    string
  >
}

/**
 * « 60 mois (5 ans) », « 18 mois (1 an et 6 mois) », « 1 mois » : la durée
 * telle qu'on la dit, à côté du nombre saisi.
 */
export function formatRetentionMonths(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  const base = `${months} mois`
  if (years === 0) return base
  const yearsText = `${years} an${years > 1 ? 's' : ''}`
  return rest === 0 ? `${base} (${yearsText})` : `${base} (${yearsText} et ${rest} mois)`
}

/**
 * Les durées qui raccourcissent : au passage de nuit suivant, ce qui dépasse
 * la nouvelle durée est effacé ou anonymisé, données déjà présentes
 * comprises. L'écran le dit avant d'enregistrer, et le confirme après.
 */
export function shortenedRetentions(
  before: Pick<Tenant, RetentionKey>,
  after: RetentionDurations,
): RetentionKey[] {
  return retentionKeys.filter((key) => after[key] < before[key])
}
