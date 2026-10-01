import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SepaExportError,
  buildPain008,
  isSepaIdentifier,
  sepaAmount,
  sepaText,
  type SepaDirectDebit,
  type SepaRemittance,
} from './sepa-xml.ts'

/**
 * Fichier de remise de prélèvements `pain.008.001.02` (R16, ADR 030) : la
 * structure attendue par la banque, les montants et les sommes de contrôle,
 * le jeu de caractères SEPA, et les refus.
 */

/* Lecteur XML minimal, pour éprouver la structure sans dépendance. */
type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string }

function parseXml(xml: string): XmlNode {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '')
  const root: XmlNode = { name: '#root', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const token = /<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = token.exec(body)) !== null) {
    assert.equal(match.index, consumed, `XML illisible près de « ${body.slice(consumed, consumed + 30)} »`)
    consumed = token.lastIndex
    const [, closing, opening, rawAttributes, selfClosing, text] = match
    const current = stack[stack.length - 1]
    if (closing) {
      assert.equal(current.name, closing, `balise </${closing}> fermant <${current.name}>`)
      stack.pop()
    } else if (opening) {
      const attributes: Record<string, string> = {}
      for (const attribute of rawAttributes.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
        attributes[attribute[1]] = attribute[2]
      }
      const node: XmlNode = { name: opening, attributes, children: [], text: '' }
      current.children.push(node)
      if (!selfClosing) stack.push(node)
    } else if (text && text.trim()) {
      assert.ok(!/[<>]/.test(text), 'texte non échappé')
      current.text += text
    }
  }
  assert.equal(consumed, body.length, 'contenu après la dernière balise')
  assert.equal(stack.length, 1, `balise <${stack[stack.length - 1].name}> non fermée`)
  assert.equal(root.children.length, 1, 'une seule racine')
  return root.children[0]
}

function child(node: XmlNode, ...path: string[]): XmlNode {
  let current = node
  for (const name of path) {
    const next = current.children.find((candidate) => candidate.name === name)
    assert.ok(next, `<${name}> absent sous <${current.name}>`)
    current = next
  }
  return current
}

const children = (node: XmlNode, name: string) => node.children.filter((candidate) => candidate.name === name)
const textOf = (node: XmlNode, ...path: string[]) => child(node, ...path).text
const unescape = (value: string) =>
  value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const transaction = (values: Partial<SepaDirectDebit> = {}): SepaDirectDebit => ({
  endToEndId: 'FA-2026-0001',
  amountCents: 12_000,
  mandateReference: 'RUM-20260115-ABCDEF',
  mandateSignedOn: '2026-01-15',
  sequenceType: 'FRST',
  debtorName: 'Atelier Durand',
  debtorIban: 'DE89370400440532013000',
  debtorBic: 'COBADEFFXXX',
  remittanceInformation: 'Facture FA-2026-0001',
  ...values,
})

const remittance = (values: Partial<SepaRemittance> = {}): SepaRemittance => ({
  messageId: 'PRLV-20261001-7KQ2XD',
  createdAt: '2026-10-01T09:30:00',
  requestedCollectionDate: '2026-10-05',
  creditor: {
    name: 'Centre de démonstration SAS',
    iban: 'FR7630006000011234567890189',
    bic: 'AGRIFRPP',
    creditorId: 'FR12ZZZ123456',
  },
  transactions: [transaction()],
  ...values,
})

describe('montants SEPA', () => {
  it('écrit les centimes en décimal à point, par arithmétique entière', () => {
    assert.equal(sepaAmount(1), '0.01')
    assert.equal(sepaAmount(10), '0.10')
    assert.equal(sepaAmount(12_000), '120.00')
    assert.equal(sepaAmount(123_456_789), '1234567.89')
    assert.throws(() => sepaAmount(-1), RangeError)
    assert.throws(() => sepaAmount(1.5), RangeError)
  })
})

describe('jeu de caractères SEPA', () => {
  it('retire accents et ligatures, remplace le reste par une espace', () => {
    assert.equal(sepaText('Société Générale & Fils — Café « Œuvre »', 70), 'Societe Generale + Fils - Cafe OEuvre')
    assert.equal(sepaText('L’Atelier   de\tMaëlle', 70), "L'Atelier de Maelle")
    assert.equal(sepaText('Straße', 70), 'Strasse')
  })

  it('coupe à la longueur permise', () => {
    assert.equal(sepaText('A'.repeat(80), 70).length, 70)
  })

  it('reconnaît un identifiant SEPA', () => {
    assert.equal(isSepaIdentifier('FA-2026-0001'), true)
    assert.equal(isSepaIdentifier('RUM-20261001-AB9A9E'), true)
    assert.equal(isSepaIdentifier('/FA'), false)
    assert.equal(isSepaIdentifier('FA//1'), false)
    assert.equal(isSepaIdentifier('FA_2026'), false)
    assert.equal(isSepaIdentifier('X'.repeat(36)), false)
  })
})

describe('message pain.008.001.02', () => {
  it('pose l’en-tête de groupe : identifiant, date, nombre et somme de contrôle', () => {
    const document = parseXml(
      buildPain008(
        remittance({
          transactions: [
            transaction({ endToEndId: 'FA-2026-0001', amountCents: 10 }),
            transaction({ endToEndId: 'FA-2026-0002', amountCents: 20 }),
            transaction({ endToEndId: 'FA-2026-0003', amountCents: 123_456 }),
          ],
        }),
      ),
    )
    assert.equal(document.name, 'Document')
    assert.equal(document.attributes.xmlns, 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.02')
    const header = child(document, 'CstmrDrctDbtInitn', 'GrpHdr')
    assert.equal(textOf(header, 'MsgId'), 'PRLV-20261001-7KQ2XD')
    assert.equal(textOf(header, 'CreDtTm'), '2026-10-01T09:30:00')
    assert.equal(textOf(header, 'NbOfTxs'), '3')
    // 0,10 + 0,20 + 1 234,56 : pas d'erreur de flottant.
    assert.equal(textOf(header, 'CtrlSum'), '1234.86')
    assert.equal(textOf(header, 'InitgPty', 'Nm'), 'Centre de demonstration SAS')
  })

  it('fait un lot par type de séquence, avec ses propres totaux', () => {
    const document = parseXml(
      buildPain008(
        remittance({
          transactions: [
            transaction({ endToEndId: 'FA-2026-0001', sequenceType: 'RCUR', amountCents: 5_000 }),
            transaction({ endToEndId: 'FA-2026-0002', sequenceType: 'FRST', amountCents: 7_000 }),
            transaction({ endToEndId: 'FA-2026-0003', sequenceType: 'RCUR', amountCents: 2_550 }),
            transaction({ endToEndId: 'FA-2026-0004', sequenceType: 'OOFF', amountCents: 1_000 }),
          ],
        }),
      ),
    )
    const initiation = child(document, 'CstmrDrctDbtInitn')
    const batches = children(initiation, 'PmtInf')
    assert.deepEqual(
      batches.map((batch) => [
        textOf(batch, 'PmtTpInf', 'SeqTp'),
        textOf(batch, 'PmtInfId'),
        textOf(batch, 'NbOfTxs'),
        textOf(batch, 'CtrlSum'),
      ]),
      [
        ['FRST', 'PRLV-20261001-7KQ2XD-FRST', '1', '70.00'],
        ['RCUR', 'PRLV-20261001-7KQ2XD-RCUR', '2', '75.50'],
        ['OOFF', 'PRLV-20261001-7KQ2XD-OOFF', '1', '10.00'],
      ],
    )
    // Chaque lot additionne exactement ses prélèvements.
    for (const batch of batches) {
      const amounts = children(batch, 'DrctDbtTxInf').map((tx) => {
        const [euros, cents] = textOf(tx, 'InstdAmt').split('.')
        return Number(euros) * 100 + Number(cents)
      })
      assert.equal(String(amounts.length), textOf(batch, 'NbOfTxs'))
      assert.equal(sepaAmount(amounts.reduce((total, amount) => total + amount, 0)), textOf(batch, 'CtrlSum'))
    }
    assert.equal(textOf(child(document, 'CstmrDrctDbtInitn', 'GrpHdr'), 'CtrlSum'), '155.50')
  })

  it('décrit le créancier, le schéma CORE et la date de prélèvement', () => {
    const batch = child(parseXml(buildPain008(remittance())), 'CstmrDrctDbtInitn', 'PmtInf')
    assert.equal(textOf(batch, 'PmtMtd'), 'DD')
    assert.equal(textOf(batch, 'PmtTpInf', 'SvcLvl', 'Cd'), 'SEPA')
    assert.equal(textOf(batch, 'PmtTpInf', 'LclInstrm', 'Cd'), 'CORE')
    assert.equal(textOf(batch, 'ReqdColltnDt'), '2026-10-05')
    assert.equal(textOf(batch, 'CdtrAcct', 'Id', 'IBAN'), 'FR7630006000011234567890189')
    assert.equal(textOf(batch, 'CdtrAgt', 'FinInstnId', 'BIC'), 'AGRIFRPP')
    assert.equal(textOf(batch, 'ChrgBr'), 'SLEV')
    const scheme = child(batch, 'CdtrSchmeId', 'Id', 'PrvtId', 'Othr')
    assert.equal(textOf(scheme, 'Id'), 'FR12ZZZ123456')
    assert.equal(textOf(scheme, 'SchmeNm', 'Prtry'), 'SEPA')
  })

  it('décrit chaque prélèvement : référence, montant en euros, mandat, débiteur', () => {
    const tx = child(parseXml(buildPain008(remittance())), 'CstmrDrctDbtInitn', 'PmtInf', 'DrctDbtTxInf')
    assert.equal(textOf(tx, 'PmtId', 'EndToEndId'), 'FA-2026-0001')
    assert.equal(textOf(tx, 'InstdAmt'), '120.00')
    assert.equal(child(tx, 'InstdAmt').attributes.Ccy, 'EUR')
    assert.equal(textOf(tx, 'DrctDbtTx', 'MndtRltdInf', 'MndtId'), 'RUM-20260115-ABCDEF')
    assert.equal(textOf(tx, 'DrctDbtTx', 'MndtRltdInf', 'DtOfSgntr'), '2026-01-15')
    assert.equal(textOf(tx, 'DbtrAgt', 'FinInstnId', 'BIC'), 'COBADEFFXXX')
    assert.equal(textOf(tx, 'Dbtr', 'Nm'), 'Atelier Durand')
    assert.equal(textOf(tx, 'DbtrAcct', 'Id', 'IBAN'), 'DE89370400440532013000')
    assert.equal(textOf(tx, 'RmtInf', 'Ustrd'), 'Facture FA-2026-0001')
  })

  it('écrit NOTPROVIDED quand un BIC manque', () => {
    const xml = buildPain008(
      remittance({
        creditor: { ...remittance().creditor, bic: null },
        transactions: [transaction({ debtorBic: null })],
      }),
    )
    const batch = child(parseXml(xml), 'CstmrDrctDbtInitn', 'PmtInf')
    assert.equal(textOf(batch, 'CdtrAgt', 'FinInstnId', 'Othr', 'Id'), 'NOTPROVIDED')
    assert.equal(textOf(batch, 'DrctDbtTxInf', 'DbtrAgt', 'FinInstnId', 'Othr', 'Id'), 'NOTPROVIDED')
  })

  it('transcrit les noms et échappe ce qui doit l’être', () => {
    const xml = buildPain008(
      remittance({
        transactions: [
          transaction({ debtorName: 'Dupont & Fils <SARL>', remittanceInformation: "Facture FA-2026-0001 l'été" }),
        ],
      }),
    )
    const tx = child(parseXml(xml), 'CstmrDrctDbtInitn', 'PmtInf', 'DrctDbtTxInf')
    assert.equal(textOf(tx, 'Dbtr', 'Nm'), 'Dupont + Fils SARL')
    assert.equal(unescape(textOf(tx, 'RmtInf', 'Ustrd')), "Facture FA-2026-0001 l'ete")
    assert.ok(xml.includes('l&apos;ete'))
  })
})

describe('refus d’une remise', () => {
  const problemsOf = (value: SepaRemittance): string[] => {
    try {
      buildPain008(value)
    } catch (error) {
      assert.ok(error instanceof SepaExportError)
      return error.problems
    }
    assert.fail('remise acceptée')
  }

  it('refuse une remise vide ou sans identifiant créancier', () => {
    assert.ok(problemsOf(remittance({ transactions: [] })).includes('aucun prélèvement à remettre'))
    const problems = problemsOf(remittance({ creditor: { ...remittance().creditor, creditorId: '' } }))
    assert.ok(problems.some((problem) => problem.includes('ICS')))
  })

  it('refuse un IBAN invalide sans jamais le citer', () => {
    const problems = problemsOf(remittance({ transactions: [transaction({ debtorIban: 'DE89370400440532013001' })] }))
    assert.deepEqual(problems, ['FA-2026-0001 : IBAN du débiteur invalide'])
    assert.ok(!problems.join(' ').includes('3704'))
  })

  it('refuse un montant nul, une référence en double, un mandat signé après le prélèvement', () => {
    const problems = problemsOf(
      remittance({
        transactions: [
          transaction({ amountCents: 0 }),
          transaction({ mandateSignedOn: '2026-10-06' }),
        ],
      }),
    )
    assert.deepEqual(problems, [
      'FA-2026-0001 : montant invalide',
      'référence « FA-2026-0001 » présente deux fois',
      'FA-2026-0001 : mandat signé après la date de prélèvement',
    ])
  })
})
