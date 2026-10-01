import type { PaymentMethod, Tenant } from '../../db/tenants.ts'
import type { Client } from '../clients/schema.ts'
import type {
  Invoice,
  InvoiceKind,
  InvoiceLegalMentions,
  InvoiceLine,
  VatCategory,
} from './schema-factures.ts'

/**
 * Ce que porte la vue imprimable d'une facture (R13, ADR 026) : le PDF n'est
 * qu'une vue des données structurées.
 *
 * Une facture émise se lit **dans ses instantanés** : vendeur, acheteur et
 * mentions tels qu'ils étaient à l'émission, même si le centre ou le client
 * ont changé depuis. Un brouillon se lit dans les fiches du jour, marqué comme
 * tel : il n'a pas valeur de facture.
 */

export type DocumentSeller = {
  legalName: string | null
  legalForm: string | null
  shareCapitalCents: number | null
  siren: string | null
  siret: string | null
  vatNumber: string | null
  rcsCity: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
  email: string | null
  phone: string | null
  bankIban: string | null
  bankBic: string | null
  sepaCreditorId: string | null
}

export type DocumentBuyer = {
  name: string
  legalForm: string | null
  siret: string | null
  siren: string | null
  vatNumber: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
}

export type VatBreakdownRow = {
  vatCategory: VatCategory
  vatRateBp: number
  taxableAmountCents: number
  vatAmountCents: number
  exemptionReason: string | null
}

export type InvoiceDocument = {
  isDraft: boolean
  kind: InvoiceKind
  number: string | null
  issueDate: string | null
  dueDate: string | null
  seller: DocumentSeller
  buyer: DocumentBuyer
  mentions: InvoiceLegalMentions
  paymentMethod: PaymentMethod
  mandateReference: string | null
  vatBreakdown: VatBreakdownRow[]
}

/** Les neuf premiers chiffres d'un SIRET, quand c'en est un. */
export function sirenOf(siret: string | null): string | null {
  const digits = (siret ?? '').replace(/\s/g, '')
  return /^[0-9]{14}$/.test(digits) ? digits.slice(0, 9) : null
}

/**
 * TVA par catégorie et par taux, telle que la base l'a répartie sur les
 * lignes (EN 16931, BG-23) : la somme des TVA des lignes d'un taux est la TVA
 * du taux, au centime.
 */
export function vatBreakdownOf(
  lines: readonly Pick<
    InvoiceLine,
    'vatCategory' | 'vatRateBp' | 'netAmountCents' | 'vatAmountCents' | 'vatExemptionReason'
  >[],
): VatBreakdownRow[] {
  const rows = new Map<string, VatBreakdownRow>()
  for (const line of lines) {
    const key = `${line.vatCategory}|${line.vatRateBp}`
    const row = rows.get(key) ?? {
      vatCategory: line.vatCategory,
      vatRateBp: line.vatRateBp,
      taxableAmountCents: 0,
      vatAmountCents: 0,
      exemptionReason: null,
    }
    row.taxableAmountCents += line.netAmountCents ?? 0
    row.vatAmountCents += line.vatAmountCents
    row.exemptionReason ??= line.vatExemptionReason
    rows.set(key, row)
  }
  return [...rows.values()].sort(
    (a, b) => b.vatRateBp - a.vatRateBp || (a.vatCategory < b.vatCategory ? -1 : 1),
  )
}

export function invoiceDocument(
  invoice: Invoice,
  lines: readonly InvoiceLine[],
  live: { tenant: Tenant; client: Client; creditedInvoiceNumber: string | null },
): InvoiceDocument {
  const isDraft = invoice.status === 'draft'
  const { tenant, client } = live
  const seller: DocumentSeller =
    !isDraft && invoice.sellerSnapshot
      ? { ...invoice.sellerSnapshot }
      : {
          legalName: tenant.legalName,
          legalForm: tenant.legalForm,
          shareCapitalCents: tenant.shareCapitalCents,
          siren: tenant.siren,
          siret: tenant.siret,
          vatNumber: tenant.vatNumber,
          rcsCity: tenant.rcsCity,
          addressLine1: tenant.addressLine1,
          addressLine2: tenant.addressLine2,
          postalCode: tenant.postalCode,
          city: tenant.city,
          country: tenant.country,
          email: tenant.email,
          phone: tenant.phone,
          bankIban: tenant.bankIban,
          bankBic: tenant.bankBic,
          sepaCreditorId: tenant.sepaCreditorId,
        }
  const buyer: DocumentBuyer =
    !isDraft && invoice.buyerSnapshot
      ? { ...invoice.buyerSnapshot }
      : {
          name: client.name,
          legalForm: client.legalForm,
          siret: client.siret,
          siren: sirenOf(client.siret),
          vatNumber: client.vatNumber,
          addressLine1: client.addressLine1,
          addressLine2: client.addressLine2,
          postalCode: client.postalCode,
          city: client.city,
          country: client.country,
        }
  const mentions: InvoiceLegalMentions =
    !isDraft && invoice.legalMentions
      ? invoice.legalMentions
      : {
          paymentTermsDays:
            invoice.kind === 'credit_note' ? 0 : (invoice.paymentTermsDays ?? tenant.invoicePaymentTermsDays),
          latePaymentPenaltyText: tenant.latePaymentPenaltyText,
          recoveryIndemnityCents: tenant.recoveryIndemnityCents,
          earlyPaymentDiscountText: tenant.earlyPaymentDiscountText,
          vatOnDebits: tenant.vatOnDebits,
          operationCategory: 'services',
          footerText: tenant.invoiceFooterText,
          creditedInvoiceNumber: live.creditedInvoiceNumber,
        }

  return {
    isDraft,
    kind: invoice.kind,
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    seller,
    buyer,
    mentions,
    paymentMethod: invoice.expectedPaymentMethod,
    mandateReference: invoice.mandateReference,
    vatBreakdown: vatBreakdownOf(lines),
  }
}

/**
 * Ce qu'`issue_invoice()` exigera, dit avant de cliquer : les mentions
 * obligatoires du vendeur et de l'acheteur, et de quoi payer (ADR 026, 027).
 * La base revérifie à l'émission ; cette liste n'est qu'un avertissement.
 */
export function missingForIssue(
  invoice: Pick<Invoice, 'kind' | 'expectedPaymentMethod' | 'sepaMandateId'>,
  tenant: Pick<
    Tenant,
    'legalName' | 'addressLine1' | 'postalCode' | 'city' | 'siren' | 'vatNumber' | 'bankIban' | 'sepaCreditorId'
  >,
  client: Pick<Client, 'addressLine1' | 'postalCode' | 'city'>,
  hasActiveMandate: boolean,
): string[] {
  const blank = (value: string | null) => !value || value.trim() === ''
  const missing: string[] = []
  if (blank(tenant.legalName)) missing.push('raison sociale du centre')
  if (blank(tenant.addressLine1) || blank(tenant.postalCode) || blank(tenant.city)) {
    missing.push('adresse du centre')
  }
  if (blank(tenant.siren)) missing.push('SIREN du centre')
  if (blank(tenant.vatNumber)) missing.push('numéro de TVA intracommunautaire du centre')
  if (blank(client.addressLine1) || blank(client.postalCode) || blank(client.city)) {
    missing.push('adresse du client')
  }
  if (invoice.kind === 'invoice') {
    if (invoice.expectedPaymentMethod === 'transfer' && blank(tenant.bankIban)) {
      missing.push('IBAN du centre (paiement par virement)')
    }
    if (invoice.expectedPaymentMethod === 'direct_debit') {
      if (blank(tenant.sepaCreditorId)) missing.push('identifiant créancier SEPA du centre')
      if (!invoice.sepaMandateId || !hasActiveMandate) missing.push('mandat de prélèvement actif du client')
    }
  }
  return missing
}

/** « FR76 3000 6000 0112 3456 7890 189 » : un IBAN lisible, par groupes de quatre. */
export function formatIban(iban: string): string {
  return iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim()
}
