import {
  DB_CHECK_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INSPECTION_INVALID,
  DB_INSPECTION_LOCKED,
  DB_UNIQUE_VIOLATION,
  dbConstraintName,
  dbErrorCode,
} from '../../db/errors.ts'

/**
 * Refus de la base sur les états des lieux, traduits pour l'écran (ADR 039).
 *
 * `CA011` (saisie non conforme) et `CA010` (état figé) portent un message en
 * français, écrit pour être montré ; les contraintes nommées sont traduites
 * ici. Tout le reste est une panne, et remonte.
 */

/** Refus métier : le message est à montrer à la personne. */
export class InspectionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InspectionRefusal'
  }
}

const constraintMessages: Record<string, string> = {
  inspections_exit_per_entry_key:
    'Cette entrée a déjà son état des lieux de sortie : ouvrez-le plutôt que d’en créer un second.',
  inspection_templates_type_key:
    'Une autre personne vient de publier le modèle de ce type. Rechargez la page avant de recommencer.',
  inspection_template_versions_version_key:
    'Une autre personne vient de publier une version de ce modèle. Rechargez la page avant de recommencer.',
  inspections_booking_fk: 'Cette réservation n’est pas celle de ce client.',
  inspections_contract_fk: 'Ce contrat n’est pas celui de ce client.',
  inspections_entry_fk:
    'L’état des lieux d’entrée désigné n’est pas celui de ce client et de cette ressource.',
  inspections_signed_by_member_fk: 'Cette personne n’est pas de l’entreprise concernée.',
  inspection_photos_content_type_allowed: 'Seules les photos JPEG, WebP et PNG sont acceptées.',
  inspection_photos_byte_size_valid: 'La photo dépasse 10 Mo.',
  inspection_photos_dimensions_valid: 'Les dimensions de cette photo dépassent 10 000 pixels.',
}

/** Message de la base, à travers l'enveloppe de Drizzle. */
function databaseMessage(error: unknown, code: string): string | undefined {
  // Les gardes lèvent `SIGNAL … MESSAGE_TEXT = 'CA010: <message>'` : le message
  // du driver (`sqlMessage`) commence par le code, que l'on retire. La base
  // coupe à 128 caractères ; la saisie est déjà vérifiée côté code (champs.ts).
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { sqlMessage } = cause as { sqlMessage?: unknown }
    if (typeof sqlMessage === 'string' && sqlMessage.startsWith(`${code}:`)) {
      return sqlMessage.slice(code.length + 1).trim()
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Le refus à montrer, ou `undefined` si l'erreur n'est pas un refus métier
 * (une panne, à laisser remonter).
 */
export function inspectionRefusalMessage(error: unknown): string | undefined {
  if (error instanceof InspectionRefusal) return error.message
  const code = dbErrorCode(error)
  if (code === DB_INSPECTION_INVALID || code === DB_INSPECTION_LOCKED) {
    return databaseMessage(error, code) ?? 'La base a refusé cette saisie.'
  }
  if (
    code === DB_UNIQUE_VIOLATION ||
    code === DB_FOREIGN_KEY_VIOLATION ||
    code === DB_CHECK_VIOLATION
  ) {
    const constraint = dbConstraintName(error)
    if (constraint && constraintMessages[constraint]) return constraintMessages[constraint]
  }
  return undefined
}
