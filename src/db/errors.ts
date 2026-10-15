/**
 * Lecture des erreurs MySQL remontées par Drizzle.
 *
 * Le code métier doit distinguer un conflit de créneau — cas normal, à
 * expliquer à l'utilisateur — d'une panne, qui doit remonter. MySQL numérote
 * ses erreurs (`errno`) ; ce module les ramène à des codes à cinq caractères
 * qui portent les mêmes noms que les SQLSTATE PostgreSQL d'origine, pour que
 * le code métier lise « 23505 » comme avant.
 *
 * Les règles métier de la base (triggers, procédures) lèvent
 * `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA009: …'` : leur code est le
 * préfixe du message (voir `src/db/regles/`).
 */

type DriverError = {
  errno?: unknown
  sqlMessage?: unknown
  cause?: unknown
}

/**
 * Drizzle enveloppe les erreurs du driver dans une `DrizzleQueryError` : le
 * code d'origine est enfoui dans la chaîne des `cause`. Sans ce déroulage,
 * toutes les erreurs de base se ressemblent.
 */
function driverError(error: unknown): DriverError | undefined {
  // La borne coupe une chaîne de `cause` circulaire.
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const e = cause as DriverError
    if (typeof e.errno === 'number' || typeof e.sqlMessage === 'string') return e
    cause = e.cause
  }
  return undefined
}

const BY_ERRNO: Record<number, string> = {
  1062: '23505', // ER_DUP_ENTRY
  1586: '23505', // ER_DUP_ENTRY_WITH_KEY_NAME
  1452: '23503', // ER_NO_REFERENCED_ROW_2
  1451: '23503', // ER_ROW_IS_REFERENCED_2
  1216: '23503',
  1217: '23503',
  3819: '23514', // ER_CHECK_CONSTRAINT_VIOLATED
  4025: '23514',
  1048: '23502', // ER_BAD_NULL_ERROR
  1364: '23502', // ER_NO_DEFAULT_FOR_FIELD
  1213: '40P01', // ER_LOCK_DEADLOCK
  1205: '55P03', // ER_LOCK_WAIT_TIMEOUT
  1142: '42501', // ER_TABLEACCESS_DENIED_ERROR
  1143: '42501',
  1370: '42501',
}

const APP_CODE = /^(CA\d{3}):/

/**
 * Code normalisé de l'erreur : `23505` (unicité), `23503` (clé étrangère),
 * `23514` (check), `23502` (not null), `42501` (droit refusé), `40P01`
 * (interblocage), `CA000`… (règles métier de la base), ou `undefined`.
 */
export function dbErrorCode(error: unknown): string | undefined {
  const e = driverError(error)
  if (!e) return undefined
  if (typeof e.sqlMessage === 'string') {
    const match = APP_CODE.exec(e.sqlMessage)
    if (match) return match[1]
  }
  return typeof e.errno === 'number' ? BY_ERRNO[e.errno] : undefined
}

/**
 * Nom de la contrainte ou de l'index en cause. MySQL le met dans le message :
 * `Duplicate entry 'x' for key 'resources.resources_tenant_code_key'` ou
 * `Check constraint 'bookings_valid_range' is violated.`
 *
 * Sert à distinguer deux unicités d'une même table.
 */
export function dbConstraintName(error: unknown): string | undefined {
  const message = driverError(error)?.sqlMessage
  if (typeof message !== 'string') return undefined
  // Le message dépend de la langue du serveur (`lc_messages`, forcée en
  // anglais par `createDatabase`) : pour une unicité, la clé est le dernier
  // texte entre apostrophes, éventuellement préfixé du nom de table.
  const errno = driverError(error)?.errno
  if (errno === 1062 || errno === 1586) {
    const quoted = [...message.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const key = quoted.at(-1)
    return key?.includes('.') ? key.split('.').pop() : key
  }
  const duplicate = /for key '(?:[^'.]+\.)?([^']+)'/.exec(message)
  if (duplicate) return duplicate[1]
  const check = /Check constraint '([^']+)'/.exec(message)
  if (check) return check[1]
  const foreign = /CONSTRAINT `([^`]+)`/.exec(message)
  return foreign?.[1]
}

/**
 * Deux réservations se chevauchent (décision 3). Levée par le trigger
 * `bookings_no_overlap_*` (`src/db/regles/`) : MySQL n'a pas de contrainte
 * d'exclusion, le trigger verrouille la ressource puis refuse le chevauchement.
 */
export const DB_EXCLUSION_VIOLATION = 'CA000'
/** Index unique : un code de ressource ou un numéro de casier déjà pris dans le centre. */
export const DB_UNIQUE_VIOLATION = '23505'
/** Contrainte `check` : intervalle vide, annulation incohérente. */
export const DB_CHECK_VIOLATION = '23514'
/** Clé étrangère : ressource absente, ou appartenant à un autre centre. */
export const DB_FOREIGN_KEY_VIOLATION = '23503'
/** `not null` : une colonne obligatoire omise, comme le canal d'une réservation. */
export const DB_NOT_NULL_VIOLATION = '23502'
/** Droit refusé à l'utilisateur applicatif : écrire un compteur de numérotation, par exemple. */
export const DB_INSUFFICIENT_PRIVILEGE = '42501'
/**
 * Écriture directe d'une occupation de contrat (`bookings.kind = 'contract'`),
 * refusée par le trigger `bookings_guard_contract_occupation` (ADR 018).
 * Elle se modifie à travers son contrat.
 */
export const DB_CONTRACT_OCCUPATION_LOCKED = 'CA001'
/**
 * Facture émise, ou brouillon abandonné : figé (ADR 026). Une correction passe
 * par un avoir. Aussi : suppression d'une facture ou d'une ligne, réécriture
 * du journal des exports comptables.
 */
export const DB_INVOICE_LOCKED = 'CA002'
/**
 * Facture non conforme (ADR 026) : émission refusée (mention obligatoire
 * manquante, facture vide ou négative, mandat absent), avoir excédentaire,
 * ligne incohérente, émission hors `issue_invoice`. Le message dit quoi compléter.
 */
export const DB_INVOICE_INVALID = 'CA003'
/**
 * Engagement figé (ADR 025) : prix ou lignes d'un contrat qui n'est plus un
 * brouillon (passer par un avenant), avenant signé, souscription, document de
 * contrat, date de début d'un contrat qui a des avenants signés.
 */
export const DB_COMMITMENT_LOCKED = 'CA004'
/** Avenant refusé (ADR 025) : contrat pas en cours, date d'effet incohérente, avenant sans effet. */
export const DB_AMENDMENT_INVALID = 'CA005'
/** Paiement refusé (ADR 027) : facture brouillon ou avoir, autre devise, modification ou suppression. */
export const DB_PAYMENT_REFUSED = 'CA006'
/** Mandat SEPA : la RUM et le client ne changent pas, un mandat ne se supprime pas (ADR 027). */
export const DB_SEPA_MANDATE_LOCKED = 'CA007'
/** Demande de courrier refusée (ADR 037) : transition impossible, pli retiré, auteur manquant… */
export const DB_MAIL_REQUEST_REFUSED = 'CA008'
/** Réservation depuis l'espace client refusée (ADR 036) : ressource fermée, annulation non permise… */
export const DB_CLIENT_BOOKING_REFUSED = 'CA009'
/** État des lieux figé (ADR 039) : état clos, photo sur un état clos, suppression. */
export const DB_INSPECTION_LOCKED = 'CA010'
/** État des lieux non conforme (ADR 039) : valeur hors modèle, champ obligatoire vide à la clôture. */
export const DB_INSPECTION_INVALID = 'CA011'
/** Anonymisation refusée (ADR 040) : exclusion, membre non retiré, écriture hors `anonymize_*`. */
export const DB_ANONYMIZATION_REFUSED = 'CA012'
/** Demande d'offre refusée (ADR 041) : offre non présentée, demande déjà traitée, auteur manquant. */
export const DB_OFFER_REQUEST_REFUSED = 'CA013'
/**
 * Écriture pour un autre centre que celui du contexte (`withTenant()`), refusée
 * par les triggers `<table>_guard_tenant_*` que le migrateur génère. Remplace
 * le `WITH CHECK` des politiques RLS de PostgreSQL.
 */
export const DB_TENANT_MISMATCH = 'CA014'
/** Écriture hors de la portée client du contexte (`withClientScope()`), refusée par les triggers de garde de facturation. */
export const DB_CLIENT_SCOPE_REFUSED = 'CA015'
