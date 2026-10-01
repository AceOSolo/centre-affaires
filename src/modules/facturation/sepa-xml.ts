import { isValidIban, normalizeIban } from './iban.ts'
import type { SepaSequenceCode } from './mandats-regles.ts'
import { isIsoDate } from './paiements-regles.ts'

/**
 * Fichier de remise de prélèvements SEPA à la banque (R16, ADR 027, ADR 028) :
 * message ISO 20022 `pain.008.001.02` (« Customer Direct Debit Initiation »),
 * schéma SEPA Core, celui qu'acceptent les banques françaises.
 *
 * Construit en chaîne, sans dépendance : le message est court, sa structure
 * fixe, et chaque valeur passe par une transcription au jeu de caractères
 * SEPA puis par l'échappement XML. `sepa-xml.test.ts` éprouve la structure,
 * les nombres et les sommes de contrôle.
 *
 * Module pur : pas de base, pas de date courante. Les montants sont des
 * centimes entiers, écrits en décimal par arithmétique entière (décision 5).
 *
 * Le fichier contient les IBAN des débiteurs en clair : il se génère à la
 * demande, se télécharge, et n'est ni stocké ni journalisé.
 */

export type SepaDirectDebit = {
  /** Identifiant de bout en bout, rendu au créancier en cas de rejet : le numéro de facture. */
  endToEndId: string
  amountCents: number
  /** RUM. */
  mandateReference: string
  mandateSignedOn: string
  sequenceType: SepaSequenceCode
  debtorName: string
  debtorIban: string
  /** Facultatif depuis 2016 pour un compte de la zone SEPA : `NOTPROVIDED`. */
  debtorBic: string | null
  /** Libellé lu par le débiteur sur son relevé, 140 caractères au plus. */
  remittanceInformation: string
}

export type SepaRemittance = {
  /** Identifiant de la remise (`MsgId`), unique chez le créancier : 30 caractères au plus. */
  messageId: string
  /** Heure murale du centre, à la seconde : « 2026-10-01T09:30:00 ». */
  createdAt: string
  /** Date d'échéance demandée à la banque (`ReqdColltnDt`). */
  requestedCollectionDate: string
  creditor: {
    name: string
    iban: string
    bic: string | null
    /** Identifiant créancier SEPA (ICS) : `FR12ZZZ123456`. */
    creditorId: string
  }
  transactions: SepaDirectDebit[]
}

/** Remise impossible : la liste dit quoi corriger, sans jamais citer un IBAN. */
export class SepaExportError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Fichier de prélèvement impossible : ${problems.join(' ; ')}`)
    this.name = 'SepaExportError'
    this.problems = problems
  }
}

/** Montant maximal d'un prélèvement SEPA : 999 999 999,99. */
const MAX_AMOUNT_CENTS = 99_999_999_999
const MAX_MESSAGE_ID = 30
const MAX_ID = 35
const MAX_NAME = 70
const MAX_REMITTANCE = 140
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const CREDITOR_ID = /^[A-Z]{2}[0-9]{2}[0-9A-Z]{1,31}$/
const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/
/** Jeu de caractères latin restreint des règles SEPA (EPC). */
const SEPA_IDENTIFIER = /^[A-Za-z0-9/\-?:().,'+ ]+$/
/** Ordre des lots dans le fichier : premiers prélèvements, récurrents, ponctuels. */
const SEQUENCE_ORDER: SepaSequenceCode[] = ['FRST', 'RCUR', 'OOFF']

/** « 1234.56 » : décimal à point, deux chiffres, par arithmétique entière. */
export function sepaAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`Montant invalide : ${cents}`)
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

const LIGATURES: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  '&': '+',
  '’': "'",
  '‘': "'",
  '–': '-',
  '—': '-',
}

/**
 * Texte libre transcrit au jeu SEPA : accents retirés (« Société » devient
 * « Societe »), ligatures développées, tout autre caractère remplacé par une
 * espace, espaces resserrées, puis coupé à `max`. Une banque refuse un fichier
 * entier pour un seul caractère hors du jeu.
 */
export function sepaText(value: string, max: number): string {
  const transliterated = value
    .replace(/[ßæÆœŒ&’‘–—]/g, (character) => LIGATURES[character] ?? ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return transliterated.slice(0, max).trim()
}

/** Identifiant SEPA : jeu restreint, ni `/` en tête ou en fin, ni `//` (règles EPC). */
export function isSepaIdentifier(value: string, max = MAX_ID): boolean {
  return (
    value.length > 0 &&
    value.length <= max &&
    SEPA_IDENTIFIER.test(value) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    value.trim() === value
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `<Tag>valeur</Tag>`, la valeur échappée. */
function element(tag: string, value: string): string {
  return `<${tag}>${escapeXml(value)}</${tag}>`
}

function agent(bic: string | null): string {
  // Sans BIC, la mention convenue « NOTPROVIDED » (règles SEPA depuis 2016).
  return bic
    ? `<FinInstnId>${element('BIC', bic)}</FinInstnId>`
    : '<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>'
}

function validate(remittance: SepaRemittance): string[] {
  const problems: string[] = []
  const { creditor } = remittance

  if (!isSepaIdentifier(remittance.messageId, MAX_MESSAGE_ID)) {
    problems.push(`identifiant de remise « ${remittance.messageId} » hors du format SEPA`)
  }
  if (!CREATED_AT.test(remittance.createdAt)) problems.push('date de création illisible')
  if (!isIsoDate(remittance.requestedCollectionDate)) problems.push('date de prélèvement illisible')
  if (!sepaText(creditor.name, MAX_NAME)) problems.push('nom du créancier manquant')
  if (!isValidIban(creditor.iban)) problems.push('IBAN du centre invalide')
  if (creditor.bic && !BIC.test(creditor.bic)) problems.push('BIC du centre invalide')
  if (!CREDITOR_ID.test(creditor.creditorId)) {
    problems.push('identifiant créancier SEPA (ICS) du centre manquant ou invalide')
  }
  if (remittance.transactions.length === 0) problems.push('aucun prélèvement à remettre')

  const seen = new Set<string>()
  for (const transaction of remittance.transactions) {
    const label = transaction.endToEndId || '(sans référence)'
    if (!isSepaIdentifier(transaction.endToEndId)) {
      problems.push(`référence « ${label} » hors du format SEPA`)
    } else if (seen.has(transaction.endToEndId)) {
      problems.push(`référence « ${label} » présente deux fois`)
    }
    seen.add(transaction.endToEndId)
    if (
      !Number.isInteger(transaction.amountCents) ||
      transaction.amountCents <= 0 ||
      transaction.amountCents > MAX_AMOUNT_CENTS
    ) {
      problems.push(`${label} : montant invalide`)
    }
    if (!isSepaIdentifier(transaction.mandateReference)) {
      problems.push(`${label} : RUM « ${transaction.mandateReference} » hors du format SEPA`)
    }
    if (!isIsoDate(transaction.mandateSignedOn)) {
      problems.push(`${label} : date de signature du mandat illisible`)
    } else if (transaction.mandateSignedOn > remittance.requestedCollectionDate) {
      problems.push(`${label} : mandat signé après la date de prélèvement`)
    }
    if (!sepaText(transaction.debtorName, MAX_NAME)) problems.push(`${label} : titulaire du compte manquant`)
    // Jamais l'IBAN dans le message : seulement la facture qu'il concerne.
    if (!isValidIban(transaction.debtorIban)) problems.push(`${label} : IBAN du débiteur invalide`)
    if (transaction.debtorBic && !BIC.test(transaction.debtorBic)) {
      problems.push(`${label} : BIC du débiteur invalide`)
    }
  }
  return problems
}

function sum(transactions: readonly SepaDirectDebit[]): number {
  return transactions.reduce((total, transaction) => total + transaction.amountCents, 0)
}

/**
 * Message `pain.008.001.02` d'une remise : un lot (`PmtInf`) par type de
 * séquence, puisque `SeqTp` se déclare au niveau du lot. Lève
 * `SepaExportError` avec la liste de ce qui empêche la remise.
 */
export function buildPain008(remittance: SepaRemittance): string {
  const problems = validate(remittance)
  if (problems.length > 0) throw new SepaExportError(problems)

  const { creditor } = remittance
  const creditorName = sepaText(creditor.name, MAX_NAME)
  const creditorIban = normalizeIban(creditor.iban)
  const transactions = remittance.transactions

  const batches = SEQUENCE_ORDER.map((sequence) => ({
    sequence,
    transactions: transactions.filter((transaction) => transaction.sequenceType === sequence),
  })).filter((batch) => batch.transactions.length > 0)

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<CstmrDrctDbtInitn>',
    '<GrpHdr>',
    element('MsgId', remittance.messageId),
    element('CreDtTm', remittance.createdAt),
    element('NbOfTxs', String(transactions.length)),
    element('CtrlSum', sepaAmount(sum(transactions))),
    `<InitgPty>${element('Nm', creditorName)}</InitgPty>`,
    '</GrpHdr>',
  ]

  for (const batch of batches) {
    lines.push(
      '<PmtInf>',
      element('PmtInfId', `${remittance.messageId}-${batch.sequence}`),
      element('PmtMtd', 'DD'),
      element('NbOfTxs', String(batch.transactions.length)),
      element('CtrlSum', sepaAmount(sum(batch.transactions))),
      '<PmtTpInf>',
      `<SvcLvl>${element('Cd', 'SEPA')}</SvcLvl>`,
      `<LclInstrm>${element('Cd', 'CORE')}</LclInstrm>`,
      element('SeqTp', batch.sequence),
      '</PmtTpInf>',
      element('ReqdColltnDt', remittance.requestedCollectionDate),
      `<Cdtr>${element('Nm', creditorName)}</Cdtr>`,
      `<CdtrAcct><Id>${element('IBAN', creditorIban)}</Id></CdtrAcct>`,
      `<CdtrAgt>${agent(creditor.bic)}</CdtrAgt>`,
      element('ChrgBr', 'SLEV'),
      '<CdtrSchmeId><Id><PrvtId><Othr>' +
        element('Id', creditor.creditorId) +
        `<SchmeNm>${element('Prtry', 'SEPA')}</SchmeNm>` +
        '</Othr></PrvtId></Id></CdtrSchmeId>',
    )
    for (const transaction of batch.transactions) {
      lines.push(
        '<DrctDbtTxInf>',
        `<PmtId>${element('EndToEndId', transaction.endToEndId)}</PmtId>`,
        `<InstdAmt Ccy="EUR">${sepaAmount(transaction.amountCents)}</InstdAmt>`,
        '<DrctDbtTx><MndtRltdInf>' +
          element('MndtId', transaction.mandateReference) +
          element('DtOfSgntr', transaction.mandateSignedOn) +
          '</MndtRltdInf></DrctDbtTx>',
        `<DbtrAgt>${agent(transaction.debtorBic)}</DbtrAgt>`,
        `<Dbtr>${element('Nm', sepaText(transaction.debtorName, MAX_NAME))}</Dbtr>`,
        `<DbtrAcct><Id>${element('IBAN', normalizeIban(transaction.debtorIban))}</Id></DbtrAcct>`,
        `<RmtInf>${element('Ustrd', sepaText(transaction.remittanceInformation, MAX_REMITTANCE) || transaction.endToEndId)}</RmtInf>`,
        '</DrctDbtTxInf>',
      )
    }
    lines.push('</PmtInf>')
  }

  lines.push('</CstmrDrctDbtInitn>', '</Document>')
  return `${lines.join('\n')}\n`
}
