import type { PaymentMethod } from '../../db/tenants.ts'
import type {
  InvoiceStatus,
  SepaMandateStatus,
  SepaSequenceType,
} from './schema-factures.ts'

/**
 * Libellés des règlements (R16, ADR 027, ADR 030) : modes de paiement, état
 * de règlement d'une facture, mandats SEPA.
 *
 * Un état se lit toujours au libellé ; la teinte, prise dans les bleus de la
 * marque, ne fait que l'accompagner (`CLAUDE.md`, « jamais l'information par
 * la couleur seule »).
 */

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  transfer: 'Virement',
  direct_debit: 'Prélèvement SEPA',
  other: 'Autre',
}

/** État de règlement d'une facture, tel que la base le déduit (ADR 026). */
export const settlementStatusLabels: Record<InvoiceStatus, string> = {
  draft: 'Brouillon',
  issued: 'À régler',
  partially_paid: 'Réglée en partie',
  paid: 'Réglée',
  cancelled: 'Annulée par avoir',
}

/** Même progression que les contrats : en attente, acquis, éteint. */
export const settlementStatusStyles: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  issued: 'bg-accent/15 text-primary',
  partially_paid: 'bg-accent/15 text-primary',
  paid: 'bg-primary text-primary-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

export const sepaMandateStatusLabels: Record<SepaMandateStatus, string> = {
  active: 'Actif',
  revoked: 'Révoqué',
  expired: 'Caduc',
}

export const sepaMandateStatusStyles: Record<SepaMandateStatus, string> = {
  active: 'bg-primary text-primary-foreground',
  revoked: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
}

export const sepaSequenceTypeLabels: Record<SepaSequenceType, string> = {
  recurrent: 'Récurrent',
  one_off: 'Ponctuel',
}

/** Champs du formulaire de mandat, pour le résumé d'erreurs. */
export type MandateField = 'debtorName' | 'iban' | 'bic' | 'signedOn' | 'sequenceType'

export const mandateFieldLabels: Record<MandateField, string> = {
  debtorName: 'Titulaire du compte',
  iban: 'IBAN',
  bic: 'BIC',
  signedOn: 'Date de signature',
  sequenceType: 'Type de mandat',
}
