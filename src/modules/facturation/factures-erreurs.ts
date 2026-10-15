import {
  DB_CHECK_VIOLATION,
  DB_EXCLUSION_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INVOICE_INVALID,
  DB_INVOICE_LOCKED,
  DB_UNIQUE_VIOLATION,
  dbConstraintName,
  dbErrorCode,
} from '../../db/errors.ts'
import { guardMessage, mentionsConstraint } from './erreurs-base.ts'

/**
 * Les refus de la base, dits à l'équipe (ADR 026).
 *
 * Les gardes de la facturation (`CA002`, `CA003`) écrivent leur message en
 * français et disent quoi corriger : il est repris tel quel. Les contraintes
 * génériques (unicité, chevauchement) ont un message technique en anglais : elles
 * sont traduites d'après leur nom.
 */
const constraintMessages: Record<string, string> = {
  invoice_lines_booking_key: 'Cette réservation est déjà facturée.',
  invoice_lines_mail_item_key: 'Ce pli est déjà facturé.',
  invoice_lines_mail_request_key: 'Cette demande de courrier est déjà facturée.',
  invoice_lines_contract_period_no_overlap:
    'Une partie de cette période est déjà facturée pour ce contrat.',
  invoice_lines_subscription_period_no_overlap:
    'Une partie de cette période est déjà facturée pour cette souscription.',
  invoices_run_period_key: 'Ce client a déjà sa facture de lot pour cette période.',
  invoices_period_ordered: 'La fin de la période précède son début.',
  invoices_payment_terms_valid: 'Le délai de paiement va de 0 à 60 jours.',
  invoices_sepa_mandate_fk: 'Ce mandat de prélèvement n’est pas celui du client.',
  invoice_lines_vat_category_consistent:
    'Un taux de TVA nul appelle une exonération, un taux positif le taux normal.',
  invoice_lines_unit_price_sign: 'Le prix d’une ligne est positif, celui d’une remise négatif.',
  invoice_lines_quantity_positive: 'La quantité est d’au moins 1.',
  invoice_lines_description_not_blank: 'La désignation est obligatoire.',
}

/** Message à montrer pour une erreur de la base, sans jamais montrer la requête. */
export function dbMessage(error: unknown): string {
  const constraint =
    dbConstraintName(error) ?? Object.keys(constraintMessages).find((name) => mentionsConstraint(error, name))
  if (constraint && constraintMessages[constraint]) return constraintMessages[constraint]
  const code = dbErrorCode(error)
  if (code === DB_INVOICE_LOCKED || code === DB_INVOICE_INVALID || code?.startsWith('CA')) {
    const message = guardMessage(error)
    if (message) return message
  }
  if (code) return `La base a refusé l’écriture (code ${code}${constraint ? `, ${constraint}` : ''}).`
  return error instanceof Error ? error.message : 'Erreur inattendue.'
}

/** Refus métier de la base : une règle de facturation, pas une panne. */
export function isInvoiceRefusal(error: unknown): boolean {
  const code = dbErrorCode(error)
  return (
    code === DB_INVOICE_LOCKED ||
    code === DB_INVOICE_INVALID ||
    code === DB_UNIQUE_VIOLATION ||
    code === DB_EXCLUSION_VIOLATION ||
    code === DB_CHECK_VIOLATION ||
    code === DB_FOREIGN_KEY_VIOLATION
  )
}

/** Une écriture de facture refusée, avec ce que la base en dit. */
export class InvoiceRefusedError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'InvoiceRefusedError'
    this.code = code
  }

  static from(error: unknown): InvoiceRefusedError {
    return new InvoiceRefusedError(dbMessage(error), dbErrorCode(error))
  }
}
