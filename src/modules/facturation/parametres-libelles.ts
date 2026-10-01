import type { ProrataRule, RecurringBillingTiming, PaymentMethod } from '../../db/tenants.ts'

/**
 * Libellés de l'écran de configuration du centre (R10) : partagés par les
 * formulaires et par leur résumé d'erreurs. Module sans dépendance, chargé
 * aussi côté client.
 */
export const centreSettingsLabels: Record<string, string> = {
  prorataRule: 'Prorata d’une période partielle',
  startedUnitToleranceMinutes: 'Tolérance avant une unité entamée',
  halfDayMinutes: 'Durée d’une demi-journée',
  defaultVatRate: 'Taux de TVA par défaut',
  invoicePaymentTermsDays: 'Échéance des factures',
  recurringBillingTiming: 'Facturation des loyers et forfaits',
  vatOnDebits: 'TVA d’après les débits',
  latePaymentPenaltyText: 'Pénalités de retard',
  recoveryIndemnity: 'Indemnité forfaitaire de recouvrement',
  earlyPaymentDiscountText: 'Escompte',
  invoiceFooterText: 'Pied de facture',
  legalName: 'Raison sociale',
  legalForm: 'Forme juridique',
  shareCapital: 'Capital social',
  siren: 'SIREN',
  siret: 'SIRET du siège',
  vatNumber: 'TVA intracommunautaire',
  rcsCity: 'Ville du RCS',
  addressLine1: 'Adresse',
  addressLine2: 'Complément d’adresse',
  postalCode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  bankIban: 'IBAN',
  bankBic: 'BIC',
  sepaCreditorId: 'Identifiant créancier SEPA (ICS)',
  defaultPaymentMethod: 'Mode de paiement par défaut',
}

export const prorataRuleLabels: Record<ProrataRule, { label: string; example: string }> = {
  calendar_days: {
    label: 'Jours réels',
    example: 'Jours couverts sur jours du mois, bornes comprises. Du 10 au 31 mars : 22/31.',
  },
  thirty_day_month: {
    label: 'Mois de 30 jours (base 30)',
    example: 'Chaque mois compte 30 jours, le dernier jour compte comme le 30. Du 10 au 31 mars : 21/30.',
  },
  none: {
    label: 'Pas de prorata',
    example: 'Une période entamée est due en entier. Du 10 au 31 mars : le mois entier.',
  },
}

export const recurringBillingTimingLabels: Record<RecurringBillingTiming, { label: string; example: string }> = {
  in_advance: {
    label: 'À échoir',
    example: 'La facture de mars porte le loyer de mars.',
  },
  in_arrears: {
    label: 'Terme échu',
    example: 'La facture de mars porte le loyer de février.',
  },
}

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  transfer: 'Virement',
  direct_debit: 'Prélèvement SEPA',
  other: 'Autre (chèque, espèces)',
}
