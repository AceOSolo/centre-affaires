import type { PaymentMethod } from '../../db/tenants.ts'
import type {
  InvoiceKind,
  InvoiceLineKind,
  InvoiceRunStatus,
  InvoiceStatus,
  VatCategory,
} from './schema-factures.ts'
import { formatBasisPoints as formatSharedBasisPoints } from './tarifs.ts'

/**
 * Libellés de la facturation (R13). Un statut se lit toujours par son texte :
 * la pastille de couleur l'accompagne, elle ne le remplace pas (`CLAUDE.md`).
 */

export const invoiceKindLabels: Record<InvoiceKind, string> = {
  invoice: 'Facture',
  credit_note: 'Avoir',
}

export const invoiceStatusLabels: Record<InvoiceStatus, string> = {
  draft: 'Brouillon',
  issued: 'Émise',
  partially_paid: 'Payée en partie',
  paid: 'Payée',
  cancelled: 'Annulée par avoir',
}

/** Un avoir n'a que deux états : brouillon, émis. */
export function invoiceStatusLabel(kind: InvoiceKind, status: InvoiceStatus): string {
  if (kind === 'credit_note') return status === 'draft' ? 'Brouillon' : 'Émis'
  return invoiceStatusLabels[status]
}

/** Portés par les bleus de marque, comme les états de réservation : un impayé n'est pas une erreur. */
export const invoiceStatusStyles: Record<InvoiceStatus, string> = {
  draft: 'border border-dashed border-primary/50 bg-accent/10 text-primary',
  issued: 'bg-primary text-primary-foreground',
  partially_paid: 'border border-primary bg-white text-primary',
  paid: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

export const invoiceLineKindLabels: Record<InvoiceLineKind, string> = {
  rent: 'Loyer',
  booking: 'Réservation',
  package: 'Forfait',
  act: 'Acte',
  discount: 'Remise',
  other: 'Autre',
}

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  transfer: 'Virement',
  direct_debit: 'Prélèvement SEPA',
  other: 'Autre',
}

/** Les modes de paiement, dans l'ordre de la saisie (sans tirer le schéma côté navigateur). */
export const paymentMethodChoices = Object.keys(paymentMethodLabels) as PaymentMethod[]

/** EN 16931, BT-151 : ce que dit la catégorie, imprimé dans la ventilation de TVA. */
export const vatCategoryLabels: Record<VatCategory, string> = {
  S: 'Taux normal ou réduit',
  Z: 'Taux zéro',
  E: 'Exonéré',
  AE: 'Autoliquidation',
  K: 'Livraison intracommunautaire',
  G: 'Exportation',
  O: 'Hors champ de la TVA',
}

export const invoiceRunStatusLabels: Record<InvoiceRunStatus, string> = {
  running: 'En cours',
  completed: 'Terminé',
  failed: 'Échoué',
}

/** « 20 % », « 5,5 % », « 2,1 % » — un taux en points de base, sans flottant. */
export const formatBasisPoints = (basisPoints: number): string => formatSharedBasisPoints(basisPoints)

/** « 22/31 » : la fraction d'une période partielle. */
export function formatProrata(numerator: number | null, denominator: number | null): string | null {
  return numerator !== null && denominator !== null ? `${numerator}/${denominator}` : null
}
