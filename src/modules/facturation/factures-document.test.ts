import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tenant } from '../../db/tenants.ts'
import type { Client } from '../clients/schema.ts'
import {
  formatIban,
  invoiceDocument,
  missingForIssue,
  sirenOf,
  vatBreakdownOf,
} from './factures-document.ts'
import { formatBasisPoints, invoiceStatusLabel } from './factures-labels.ts'
import type { Invoice, InvoiceLine } from './schema-factures.ts'

/**
 * Vue imprimable d'une facture (R13, ADR 026) : le PDF n'est qu'une vue. Une
 * facture émise se lit dans ses instantanés ; un brouillon, dans les fiches du
 * jour.
 */
const centre = {
  name: 'Centre',
  legalName: 'Centre du jour SAS',
  legalForm: 'SAS',
  shareCapitalCents: 1_000_000,
  siren: '123456789',
  siret: null,
  vatNumber: 'FR32123456789',
  rcsCity: 'Vienne',
  addressLine1: '1 rue Neuve',
  addressLine2: null,
  postalCode: '38070',
  city: 'Saint-Quentin-Fallavier',
  country: 'FR',
  email: null,
  phone: null,
  bankIban: 'FR7630006000011234567890189',
  bankBic: null,
  sepaCreditorId: null,
  invoicePaymentTermsDays: 30,
  latePaymentPenaltyText: 'Pénalités du jour.',
  recoveryIndemnityCents: 4_000,
  earlyPaymentDiscountText: 'Pas d’escompte.',
  vatOnDebits: false,
  invoiceFooterText: null,
} as unknown as Tenant

const client = {
  name: 'Atelier Durand',
  legalForm: 'SARL',
  siret: '987 654 321 00015',
  vatNumber: null,
  addressLine1: '2 place du Marché',
  addressLine2: null,
  postalCode: '38000',
  city: 'Grenoble',
  country: 'FR',
} as unknown as Client

const brouillon = {
  kind: 'invoice',
  status: 'draft',
  number: null,
  issueDate: null,
  dueDate: null,
  paymentTermsDays: null,
  expectedPaymentMethod: 'transfer',
  sepaMandateId: null,
  mandateReference: null,
  sellerSnapshot: null,
  buyerSnapshot: null,
  legalMentions: null,
} as unknown as Invoice

const ligne = (values: Partial<InvoiceLine>): InvoiceLine =>
  ({
    vatCategory: 'S',
    vatRateBp: 2000,
    netAmountCents: 0,
    vatAmountCents: 0,
    vatExemptionReason: null,
    ...values,
  }) as InvoiceLine

describe('vue d’une facture', () => {
  it('lit un brouillon dans les fiches du jour, au délai du centre', () => {
    const vue = invoiceDocument(brouillon, [], { tenant: centre, client, creditedInvoiceNumber: null })
    assert.equal(vue.isDraft, true)
    assert.equal(vue.seller.legalName, 'Centre du jour SAS')
    assert.equal(vue.buyer.siren, '987654321')
    assert.equal(vue.mentions.paymentTermsDays, 30)
    assert.equal(vue.mentions.recoveryIndemnityCents, 4_000)
  })

  it('lit une facture émise dans ses instantanés, même si le centre a changé depuis', () => {
    const emise = {
      ...brouillon,
      status: 'issued',
      number: 'FA-2026-0001',
      sellerSnapshot: { ...centre, legalName: 'Centre à l’émission SAS' },
      buyerSnapshot: { name: 'Durand à l’émission', siren: '987654321', country: 'FR' },
      legalMentions: {
        paymentTermsDays: 15,
        latePaymentPenaltyText: 'Pénalités à l’émission.',
        recoveryIndemnityCents: 4_000,
        earlyPaymentDiscountText: 'Pas d’escompte.',
        vatOnDebits: true,
        operationCategory: 'services',
        footerText: null,
        creditedInvoiceNumber: null,
      },
    } as unknown as Invoice
    const vue = invoiceDocument(emise, [], { tenant: centre, client, creditedInvoiceNumber: null })
    assert.equal(vue.isDraft, false)
    assert.equal(vue.seller.legalName, 'Centre à l’émission SAS')
    assert.equal(vue.buyer.name, 'Durand à l’émission')
    assert.equal(vue.mentions.paymentTermsDays, 15)
    assert.equal(vue.mentions.vatOnDebits, true)
  })

  it('donne un délai nul à un avoir et cite la facture corrigée', () => {
    const avoir = { ...brouillon, kind: 'credit_note' } as Invoice
    const vue = invoiceDocument(avoir, [], { tenant: centre, client, creditedInvoiceNumber: 'FA-2026-0001' })
    assert.equal(vue.mentions.paymentTermsDays, 0)
    assert.equal(vue.mentions.creditedInvoiceNumber, 'FA-2026-0001')
  })

  it('ventile la TVA par catégorie et par taux, du plus fort au plus faible', () => {
    const ventilation = vatBreakdownOf([
      ligne({ netAmountCents: 10_000, vatAmountCents: 2_000 }),
      ligne({ netAmountCents: 1_500, vatRateBp: 1000, vatAmountCents: 150 }),
      ligne({ netAmountCents: 33, vatAmountCents: 7 }),
      ligne({ netAmountCents: 5_000, vatRateBp: 0, vatCategory: 'E', vatExemptionReason: 'Art. 261 D du CGI' }),
    ])
    assert.deepEqual(ventilation, [
      { vatCategory: 'S', vatRateBp: 2000, taxableAmountCents: 10_033, vatAmountCents: 2_007, exemptionReason: null },
      { vatCategory: 'S', vatRateBp: 1000, taxableAmountCents: 1_500, vatAmountCents: 150, exemptionReason: null },
      {
        vatCategory: 'E',
        vatRateBp: 0,
        taxableAmountCents: 5_000,
        vatAmountCents: 0,
        exemptionReason: 'Art. 261 D du CGI',
      },
    ])
  })
})

describe('ce qui manque pour émettre (ADR 026, 027)', () => {
  it('ne signale rien quand tout est là', () => {
    assert.deepEqual(missingForIssue(brouillon, centre, client, false), [])
  })

  it('reprend les mentions que la base exigera', () => {
    const incomplet = { ...centre, siren: null, vatNumber: '', bankIban: null } as unknown as Tenant
    assert.deepEqual(missingForIssue(brouillon, incomplet, { ...client, city: null } as Client, false), [
      'SIREN du centre',
      'numéro de TVA intracommunautaire du centre',
      'adresse du client',
      'IBAN du centre (paiement par virement)',
    ])
  })

  it('exige un mandat actif et l’identifiant créancier pour un prélèvement', () => {
    const prelevement = { ...brouillon, expectedPaymentMethod: 'direct_debit' } as Invoice
    assert.deepEqual(missingForIssue(prelevement, centre, client, false), [
      'identifiant créancier SEPA du centre',
      'mandat de prélèvement actif du client',
    ])
  })

  it('exige le motif d’exonération d’une ligne sans TVA, pas au taux zéro (ADR 032)', () => {
    const lignes = [
      ligne({ description: 'Loyer', vatCategory: 'S' }),
      ligne({ description: 'Débours', vatCategory: 'E', vatRateBp: 0, vatExemptionReason: '  ' }),
      ligne({ description: 'Hors champ', vatCategory: 'O', vatRateBp: 0, vatExemptionReason: null }),
      ligne({ description: 'Taux zéro', vatCategory: 'Z', vatRateBp: 0, vatExemptionReason: null }),
    ]
    assert.deepEqual(missingForIssue(brouillon, centre, client, false, lignes), [
      'motif d’exonération de TVA de « Débours », « Hors champ »',
    ])
    const motivees = lignes.map((line) =>
      line.vatCategory === 'S' || line.vatCategory === 'Z'
        ? line
        : { ...line, vatExemptionReason: 'Exonération, art. 261 D du CGI' },
    )
    assert.deepEqual(missingForIssue(brouillon, centre, client, false, motivees), [])
  })

  it('n’exige pas de moyen de paiement pour un avoir', () => {
    const avoir = { ...brouillon, kind: 'credit_note' } as Invoice
    assert.deepEqual(missingForIssue(avoir, { ...centre, bankIban: null } as Tenant, client, false), [])
  })
})

describe('mises en forme', () => {
  it('écrit un taux en points de base sans flottant', () => {
    assert.equal(formatBasisPoints(2000), '20 %')
    assert.equal(formatBasisPoints(550), '5,5 %')
    assert.equal(formatBasisPoints(210), '2,1 %')
    assert.equal(formatBasisPoints(1025), '10,25 %')
  })

  it('tire le SIREN d’un SIRET, espaces compris', () => {
    assert.equal(sirenOf('987 654 321 00015'), '987654321')
    assert.equal(sirenOf('12345'), null)
    assert.equal(sirenOf(null), null)
  })

  it('groupe un IBAN par quatre', () => {
    assert.equal(formatIban('FR7630006000011234567890189'), 'FR76 3000 6000 0112 3456 7890 189')
  })

  it('dit le statut d’un avoir en deux états seulement', () => {
    assert.equal(invoiceStatusLabel('credit_note', 'issued'), 'Émis')
    assert.equal(invoiceStatusLabel('invoice', 'partially_paid'), 'Payée en partie')
  })
})
