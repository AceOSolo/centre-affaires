import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  outstandingReceived,
  readCrmInvoice,
  readPdfUrl,
  receivedInvoiceState,
  sameInvoiceFields,
  type ReceivedInvoiceFields,
} from './factures.ts'

/**
 * Factures reçues du CRM (ADR 081) : lecture de l'envoi et ce que l'espace
 * client en dit. La base est éprouvée par `factures.db.test.ts`.
 */

const envoi = {
  dolibarrId: '1834',
  tiersDolibarrId: '412',
  numero: 'FA2611-0042',
  type: 'facture',
  statut: 'a_payer',
  date: '2026-11-30',
  echeance: '2026-12-30',
  montantHtCentimes: 12000,
  montantTtcCentimes: 14400,
  resteAPayerCentimes: null,
  devise: 'EUR',
  pdf: 'https://crm.exemple.fr/document.php?hashp=abc123',
}

const lire = (corps: unknown) => {
  const read = readCrmInvoice(corps)
  if (!read.ok) assert.fail(read.message)
  return read.value
}

const refus = (corps: unknown) => {
  const read = readCrmInvoice(corps)
  assert.equal(read.ok, false, 'envoi accepté')
  return (read as { message: string }).message
}

describe('factures reçues : lecture de l’envoi', () => {
  it('lit une facture complète, montants en centimes', () => {
    assert.deepEqual(lire(envoi), {
      removed: false,
      crmId: '1834',
      thirdPartyCrmId: '412',
      fields: {
        number: 'FA2611-0042',
        kind: 'invoice',
        status: 'unpaid',
        issuedOn: '2026-11-30',
        dueOn: '2026-12-30',
        totalExclTaxCents: 12000,
        totalInclTaxCents: 14400,
        amountDueCents: null,
        currency: 'EUR',
        pdfUrl: 'https://crm.exemple.fr/document.php?hashp=abc123',
      },
    })
  })

  it('prend les valeurs par défaut : facture, euros, sans échéance ni PDF', () => {
    const { fields } = lire({ ...envoi, type: undefined, devise: undefined, echeance: null, pdf: null }) as {
      fields: ReceivedInvoiceFields
    }
    assert.deepEqual([fields.kind, fields.currency, fields.dueOn, fields.pdfUrl], ['invoice', 'EUR', null, null])
  })

  it('accepte des identifiants numériques, comme Dolibarr les envoie', () => {
    const value = lire({ ...envoi, dolibarrId: 1834, tiersDolibarrId: 412 })
    assert.deepEqual([value.crmId, (value as { thirdPartyCrmId: string }).thirdPartyCrmId], ['1834', '412'])
  })

  it('une suppression, ou une facture repassée en brouillon, la retire de l’espace client', () => {
    assert.deepEqual(lire({ dolibarrId: '1834', supprime: true }), { removed: true, crmId: '1834' })
    assert.deepEqual(lire({ dolibarrId: '1834', statut: 'brouillon' }), { removed: true, crmId: '1834' })
  })

  it('un avoir garde des montants positifs, que Dolibarr envoie négatifs', () => {
    const { fields } = lire({ ...envoi, type: 'avoir', montantHtCentimes: -12000, montantTtcCentimes: -14400 }) as {
      fields: ReceivedInvoiceFields
    }
    assert.deepEqual([fields.kind, fields.totalExclTaxCents, fields.totalInclTaxCents], ['credit_note', 12000, 14400])
  })

  it('garde le reste à payer d’une facture à payer, et seulement là', () => {
    const partielle = lire({ ...envoi, resteAPayerCentimes: 4400 }) as { fields: ReceivedInvoiceFields }
    assert.equal(partielle.fields.amountDueCents, 4400)
    const payee = lire({ ...envoi, statut: 'payee', resteAPayerCentimes: 0 }) as { fields: ReceivedInvoiceFields }
    assert.deepEqual([payee.fields.status, payee.fields.amountDueCents], ['paid', null])
    const abandonnee = lire({ ...envoi, statut: 'abandonnee', resteAPayerCentimes: 14400 }) as { fields: ReceivedInvoiceFields }
    assert.deepEqual([abandonnee.fields.status, abandonnee.fields.amountDueCents], ['cancelled', null])
  })

  it('refuse un envoi illisible, et dit quel champ corriger', () => {
    assert.match(refus(null), /objet JSON/)
    assert.match(refus([]), /objet JSON/)
    assert.match(refus({ ...envoi, dolibarrId: '' }), /« dolibarrId »/)
    assert.match(refus({ ...envoi, supprime: 'oui' }), /« supprime »/)
    assert.match(refus({ ...envoi, statut: 'validee' }), /« statut »/)
    assert.match(refus({ ...envoi, tiersDolibarrId: undefined }), /« tiersDolibarrId »/)
    assert.match(refus({ ...envoi, numero: '  ' }), /« numero »/)
    assert.match(refus({ ...envoi, numero: 'F'.repeat(65) }), /« numero »/)
    assert.match(refus({ ...envoi, type: 'proforma' }), /« type »/)
    assert.match(refus({ ...envoi, date: '2026-02-30' }), /« date »/)
    assert.match(refus({ ...envoi, echeance: '30/12/2026' }), /« echeance »/)
    assert.match(refus({ ...envoi, echeance: '2026-11-01' }), /précède/)
    assert.match(refus({ ...envoi, montantHtCentimes: 120.5 }), /centimes/)
    assert.match(refus({ ...envoi, montantTtcCentimes: '144.00' }), /centimes/)
    assert.match(refus({ ...envoi, montantHtCentimes: -100 }), /« avoir »/)
    assert.match(refus({ ...envoi, resteAPayerCentimes: -1 }), /« resteAPayerCentimes »/)
    assert.match(refus({ ...envoi, resteAPayerCentimes: 20000 }), /dépasse/)
    assert.match(refus({ ...envoi, statut: 'payee', resteAPayerCentimes: 100 }), /plus rien à payer/)
    assert.match(refus({ ...envoi, devise: 'eur' }), /« devise »/)
    assert.match(refus({ ...envoi, pdf: 'http://crm.exemple.fr/facture.pdf' }), /« pdf »/)
  })
})

describe('factures reçues : le lien du PDF', () => {
  it('accepte une adresse https, telle quelle', () => {
    assert.equal(readPdfUrl(' https://crm.exemple.fr/document.php?hashp=x '), 'https://crm.exemple.fr/document.php?hashp=x')
    assert.equal(readPdfUrl(null), null)
    assert.equal(readPdfUrl(''), null)
  })

  it('refuse ce qui n’est pas un lien https propre', () => {
    for (const lien of [
      'http://crm.exemple.fr/f.pdf',
      'javascript:alert(1)',
      'https://utilisateur:secret@crm.exemple.fr/f.pdf',
      'https://crm.exemple.fr/f .pdf',
      `https://crm.exemple.fr/${'a'.repeat(1000)}`,
      'crm.exemple.fr/f.pdf',
      42,
    ]) {
      assert.equal(readPdfUrl(lien), undefined, String(lien))
    }
  })
})

describe('factures reçues : un envoi rejoué ne change rien', () => {
  it('compare tous les champs', () => {
    const { fields } = lire(envoi) as { fields: ReceivedInvoiceFields }
    assert.equal(sameInvoiceFields(fields, { ...fields }), true)
    assert.equal(sameInvoiceFields(fields, { ...fields, status: 'paid' }), false)
    assert.equal(sameInvoiceFields(fields, { ...fields, pdfUrl: null }), false)
    assert.equal(sameInvoiceFields(fields, { ...fields, amountDueCents: 100 }), false)
  })
})

describe('factures reçues : ce que le client lit', () => {
  const facture = {
    kind: 'invoice' as const,
    status: 'unpaid' as const,
    totalInclTaxCents: 14400,
    amountDueCents: null,
    dueOn: '2026-12-30',
  }

  it('à payer, pour son total TTC quand le CRM ne dit pas le reste', () => {
    assert.deepEqual(receivedInvoiceState(facture, '2026-12-01'), {
      tone: 'due',
      label: 'À payer',
      amountDueCents: 14400,
      overdue: false,
    })
  })

  it('échue le lendemain de l’échéance, pas le jour même', () => {
    assert.equal(receivedInvoiceState(facture, '2026-12-30').overdue, false)
    assert.deepEqual(receivedInvoiceState(facture, '2026-12-31'), {
      tone: 'overdue',
      label: 'Échue',
      amountDueCents: 14400,
      overdue: true,
    })
  })

  it('payée en partie quand le reste est inférieur au total', () => {
    assert.deepEqual(receivedInvoiceState({ ...facture, amountDueCents: 4400 }, '2026-12-01'), {
      tone: 'partial',
      label: 'Payée en partie',
      amountDueCents: 4400,
      overdue: false,
    })
    assert.equal(receivedInvoiceState({ ...facture, amountDueCents: 4400 }, '2027-01-02').label, 'Échue, payée en partie')
  })

  it('payée, annulée ou avoir : rien à payer', () => {
    assert.deepEqual(receivedInvoiceState({ ...facture, status: 'paid' }, '2027-01-02'), {
      tone: 'paid',
      label: 'Payée',
      amountDueCents: 0,
      overdue: false,
    })
    assert.equal(receivedInvoiceState({ ...facture, amountDueCents: 0 }, '2027-01-02').tone, 'paid')
    assert.equal(receivedInvoiceState({ ...facture, status: 'cancelled' }, '2027-01-02').label, 'Annulée')
    assert.equal(receivedInvoiceState({ ...facture, kind: 'credit_note' }, '2027-01-02').label, 'Avoir')
  })

  it('totalise le reste à payer par devise, échu à part', () => {
    assert.deepEqual(
      outstandingReceived(
        [
          { ...facture, currency: 'EUR' },
          { ...facture, dueOn: '2026-11-15', amountDueCents: 1000, currency: 'EUR' },
          { ...facture, status: 'paid', currency: 'EUR' },
          { ...facture, kind: 'credit_note', currency: 'EUR' },
        ],
        '2026-12-01',
      ),
      [{ currency: 'EUR', dueCents: 15400, overdueCents: 1000, count: 2 }],
    )
  })
})
