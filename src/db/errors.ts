/**
 * Lecture des erreurs Postgres remontées par Drizzle.
 *
 * Le code métier doit distinguer un conflit de créneau — cas normal, à
 * expliquer à l'utilisateur — d'une panne, qui doit remonter. Cette distinction
 * repose sur le SQLSTATE, pas sur le message, qui dépend de la locale du
 * serveur.
 */

/**
 * Drizzle enveloppe les erreurs du driver dans une `DrizzleQueryError` depuis la
 * 0.44 : le code d'origine est enfoui dans la chaîne des `cause`. Sans ce
 * déroulage, toutes les erreurs de base se ressemblent.
 */
export function pgErrorCode(error: unknown): string | undefined {
  // La borne coupe une chaîne de `cause` circulaire, qu'aucun driver ne produit
  // aujourd'hui mais qui bloquerait le rendu de la page entière.
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Nom de la contrainte ou de l'index en cause (`constraint_name` du pilote),
 * même sous l'enveloppe de Drizzle. Sert à distinguer deux unicités d'une même
 * table : le code d'une ressource et le numéro d'un casier, par exemple.
 */
export function pgConstraintName(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const name = (cause as { constraint_name?: unknown }).constraint_name
    if (typeof name === 'string' && name) return name
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

/** Contrainte d'exclusion : deux réservations se chevauchent (décision 3). */
export const PG_EXCLUSION_VIOLATION = '23P01'
/** Index unique : un code de ressource ou un numéro de casier déjà pris dans le centre. */
export const PG_UNIQUE_VIOLATION = '23505'
/** Contrainte `check` : intervalle vide, annulation incohérente. */
export const PG_CHECK_VIOLATION = '23514'
/** Clé étrangère : ressource absente, ou appartenant à un autre centre. */
export const PG_FOREIGN_KEY_VIOLATION = '23503'
/** `not null` : une colonne obligatoire omise, comme le canal d'une réservation. */
export const PG_NOT_NULL_VIOLATION = '23502'
/** Droit refusé au rôle applicatif : écrire un compteur de numérotation, par exemple. */
export const PG_INSUFFICIENT_PRIVILEGE = '42501'
/**
 * Écriture directe d'une occupation de contrat (`bookings.kind = 'contract'`),
 * refusée par le trigger `bookings_guard_contract_occupation` (migration 0026,
 * ADR 018). Elle se modifie à travers son contrat.
 */
export const PG_CONTRACT_OCCUPATION_LOCKED = 'CA001'

/**
 * Facture émise, ou brouillon abandonné : figé (migration 0031, ADR 026). Une
 * correction passe par un avoir (`draft_credit_note`, puis `issue_invoice`).
 * Aussi : suppression d'une facture ou d'une ligne, réécriture du journal des
 * exports comptables.
 */
export const PG_INVOICE_LOCKED = 'CA002'
/**
 * Facture non conforme (ADR 026) : émission refusée (mention obligatoire
 * manquante, facture vide ou négative, mandat absent), avoir excédentaire,
 * ligne incohérente (source d'un autre client, source absente pour sa
 * nature), émission hors `issue_invoice()`. Le message dit quoi compléter.
 */
export const PG_INVOICE_INVALID = 'CA003'
/**
 * Engagement figé (ADR 025) : prix ou lignes d'un contrat qui n'est plus un
 * brouillon (passer par un avenant), avenant signé, souscription, document de
 * contrat, date de début d'un contrat qui a des avenants signés.
 */
export const PG_COMMITMENT_LOCKED = 'CA004'
/**
 * Avenant refusé (ADR 025) : contrat qui n'est pas en cours, date d'effet qui
 * ne suit pas le début du contrat ou le dernier avenant signé, ou qui dépasse
 * son dernier jour, avenant qui ne change rien.
 */
export const PG_AMENDMENT_INVALID = 'CA005'
/**
 * Paiement refusé (ADR 027) : facture brouillon ou avoir, autre devise,
 * modification ou suppression d'un paiement (il s'annule).
 */
export const PG_PAYMENT_REFUSED = 'CA006'
/** Mandat SEPA : la RUM et le client ne changent pas, un mandat ne se supprime pas (ADR 027). */
export const PG_SEPA_MANDATE_LOCKED = 'CA007'
