import type { PaymentMethod } from '../../db/tenants.ts'
import type { RateUnit } from './schema.ts'
import type { Invoice, InvoiceLine, VatCategory } from './schema-factures.ts'

/**
 * Représentation structurée EN 16931 d'une facture émise (R16, ADR 026,
 * ADR 030) : les termes métier (`BT-*`) et groupes (`BG-*`) de la norme, tels
 * que la plateforme agréée les lira. Aucun envoi : c'est la préparation du
 * raccordement, et la vérification que tout ce qui est obligatoire est là.
 *
 * - Les montants sont des chaînes décimales à point (« 1234.56 »), écrites
 *   depuis les centimes par arithmétique entière : jamais un flottant
 *   (décision 5).
 * - La facture est décrite **telle qu'émise** : vendeur, acheteur et mentions
 *   viennent des instantanés figés, les acomptes (BT-113) valent zéro.
 * - Une ligne de remise (`discount`, prix négatif) devient une remise de pied
 *   de facture (BG-20) : la norme interdit un prix net négatif (BR-27).
 * - Une remise ou un prorata de ligne devient une remise de ligne (BG-27) : la
 *   règle BR-LIN-04 (net = quantité × prix − remises) tient au centime.
 * - Les adresses électroniques (BT-34, BT-49) sont dérivées du SIREN (schéma
 *   0225 de l'annuaire), **à confirmer** au raccordement.
 *
 * La conversion vers le format de la plateforme (Factur-X, UBL, CII) partira
 * de cet objet. Module pur, éprouvé par `en16931.test.ts`.
 */

/** Identifiant de la spécification (BT-24) : la norme, sans extension. */
export const EN16931_SPECIFICATION = 'urn:cen.eu:en16931:2017'

type Amount = string
type Identifier = { value: string; scheme: string }

export type En16931Line = {
  'BT-126': string
  'BT-129': string
  'BT-130': string
  'BT-131': Amount
  'BG-26': { 'BT-134': string; 'BT-135': string } | null
  'BG-27': { 'BT-136': Amount; 'BT-139': string }[]
  'BG-29': { 'BT-146': Amount }
  'BG-30': { 'BT-151': VatCategory; 'BT-152': string }
  'BG-31': { 'BT-153': string }
}

export type En16931Invoice = {
  'BT-24': string
  'BT-1': string | null
  'BT-2': string | null
  'BT-3': '380' | '381'
  'BT-5': string
  'BT-9': string | null
  'BT-10': string | null
  'BT-20': string | null
  'BG-1': { 'BT-21': string | null; 'BT-22': string }[]
  'BG-3': { 'BT-25': string; 'BT-26': string | null }[]
  'BG-4': {
    'BT-27': string | null
    'BT-30': Identifier | null
    'BT-31': string | null
    'BT-33': string | null
    'BT-34': Identifier | null
    'BG-5': Address
    'BG-6': { 'BT-42': string | null; 'BT-43': string | null }
  }
  'BG-7': {
    'BT-44': string | null
    'BT-47': Identifier | null
    'BT-48': string | null
    'BT-49': Identifier | null
    'BG-8': Address
  }
  'BG-14': { 'BT-73': string; 'BT-74': string }
  'BG-16': {
    'BT-81': string
    'BT-82': string
    'BT-83': string | null
    'BG-17': { 'BT-84': string | null; 'BT-86': string | null } | null
    'BG-19': { 'BT-89': string | null; 'BT-90': string | null } | null
  }
  'BG-20': { 'BT-92': Amount; 'BT-95': VatCategory; 'BT-96': string; 'BT-97': string }[]
  'BG-22': {
    'BT-106': Amount
    'BT-107': Amount
    'BT-108': Amount
    'BT-109': Amount
    'BT-110': Amount
    'BT-112': Amount
    'BT-113': Amount
    'BT-114': Amount
    'BT-115': Amount
  }
  'BG-23': {
    'BT-116': Amount
    'BT-117': Amount
    'BT-118': VatCategory
    'BT-119': string
    'BT-120': string | null
  }[]
  'BG-25': En16931Line[]
}

type Address = {
  'BT-35': string | null
  'BT-36': string | null
  'BT-37': string | null
  'BT-38': string | null
  'BT-40': string | null
}

export type En16931Source = {
  invoice: Pick<
    Invoice,
    | 'kind'
    | 'number'
    | 'issueDate'
    | 'dueDate'
    | 'paymentTermsDays'
    | 'currency'
    | 'periodStart'
    | 'periodEnd'
    | 'buyerReference'
    | 'notes'
    | 'expectedPaymentMethod'
    | 'mandateReference'
    | 'totalExclTaxCents'
    | 'totalTaxCents'
    | 'totalInclTaxCents'
    | 'sellerSnapshot'
    | 'buyerSnapshot'
    | 'legalMentions'
  >
  lines: Pick<
    InvoiceLine,
    | 'id'
    | 'position'
    | 'kind'
    | 'description'
    | 'periodStart'
    | 'periodEnd'
    | 'quantity'
    | 'unit'
    | 'unitPriceCents'
    | 'discountBp'
    | 'discountAmountCents'
    | 'prorataNumerator'
    | 'prorataDenominator'
    | 'netAmountCents'
    | 'vatRateBp'
    | 'vatCategory'
    | 'vatExemptionReason'
    | 'vatAmountCents'
  >[]
  /** Pour un avoir : la facture rectifiée (BG-3). */
  precedingInvoice: { number: string | null; issueDate: string | null } | null
}

/** « 1234.56 », « -0.50 » : centimes en décimal à point, par arithmétique entière. */
export function centsToDecimal(cents: number): Amount {
  const sign = cents < 0 ? '-' : ''
  const magnitude = Math.abs(cents)
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`
}

/** Inverse de `centsToDecimal`, pour les contrôles arithmétiques. */
export function decimalToCents(amount: Amount): number {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(amount)
  if (!match) throw new RangeError(`Montant décimal illisible : ${amount}`)
  const cents = Number(match[2]) * 100 + Number(match[3])
  return match[1] ? -cents : cents
}

/** Taux en points de base vers pourcentage : 2000 → « 20.00 », 550 → « 5.50 ». */
export function basisPointsToPercent(rateBp: number): string {
  return `${Math.floor(rateBp / 100)}.${String(rateBp % 100).padStart(2, '0')}`
}

/** Unités de mesure (UN/ECE recommandation 20). La demi-journée n'y a pas de code : unité. */
const unitCodes: Record<RateUnit, string> = {
  hour: 'HUR',
  half_day: 'C62',
  day: 'DAY',
  week: 'WEE',
  month: 'MON',
  unit: 'C62',
}

/** Moyens de paiement (UNTDID 4461) : virement SEPA, prélèvement SEPA, non défini. */
const paymentMeansCodes: Record<PaymentMethod, { code: string; label: string }> = {
  transfer: { code: '58', label: 'Virement SEPA' },
  direct_debit: { code: '59', label: 'Prélèvement SEPA' },
  other: { code: '1', label: 'Moyen non défini' },
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function sirenScheme(siren: string | null | undefined, scheme: string): Identifier | null {
  return siren && /^\d{9}$/.test(siren) ? { value: siren, scheme } : null
}

/** « 10 000,00 » : capital social, écrit sans flottant. */
function frenchAmount(cents: number): string {
  const euros = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${euros},${String(cents % 100).padStart(2, '0')} €`
}

/** Mentions légales complémentaires du vendeur (BT-33) : forme, capital, RCS. */
function sellerLegalInformation(seller: NonNullable<Invoice['sellerSnapshot']>): string | null {
  const parts: string[] = []
  if (seller.legalForm) {
    parts.push(
      seller.shareCapitalCents !== null && seller.shareCapitalCents !== undefined
        ? `${seller.legalForm} au capital de ${frenchAmount(seller.shareCapitalCents)}`
        : seller.legalForm,
    )
  }
  if (seller.rcsCity && seller.siren) parts.push(`RCS ${seller.rcsCity} ${seller.siren}`)
  if (seller.siret) parts.push(`SIRET ${seller.siret}`)
  return parts.length > 0 ? parts.join(' — ') : null
}

function lineAllowanceReason(line: En16931Source['lines'][number]): string {
  const discounted = Boolean(line.discountBp) || Boolean(line.discountAmountCents)
  const prorated =
    line.prorataNumerator !== null &&
    line.prorataDenominator !== null &&
    line.prorataNumerator !== line.prorataDenominator
  if (discounted && prorated) return 'Remise et prorata temporis'
  if (prorated) return 'Prorata temporis'
  return 'Remise'
}

/**
 * Objet EN 16931 d'une facture ou d'un avoir émis. Une facture encore en
 * brouillon se décrit aussi — sans numéro ni date, ce que la vérification
 * signale —, mais seule une facture émise est complète.
 */
export function toEn16931(source: En16931Source): En16931Invoice {
  const { invoice } = source
  const seller = invoice.sellerSnapshot
  const buyer = invoice.buyerSnapshot
  const mentions = invoice.legalMentions
  const ordered = [...source.lines].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))

  const allowances: En16931Invoice['BG-20'] = []
  const lines: En16931Line[] = []
  let lineTotal = 0
  let allowanceTotal = 0
  ordered.forEach((line) => {
    const net = line.netAmountCents ?? 0
    if (line.kind === 'discount') {
      // BR-27 : pas de prix négatif sur une ligne. La remise passe au pied.
      if (net === 0) return
      allowanceTotal += -net
      allowances.push({
        'BT-92': centsToDecimal(-net),
        'BT-95': line.vatCategory,
        'BT-96': basisPointsToPercent(line.vatRateBp),
        'BT-97': line.description,
      })
      return
    }
    lineTotal += net
    const gross = line.quantity * line.unitPriceCents
    const lineAllowance = gross - net
    lines.push({
      'BT-126': String(lines.length + 1),
      'BT-129': String(line.quantity),
      'BT-130': unitCodes[line.unit ?? 'unit'],
      'BT-131': centsToDecimal(net),
      'BG-26':
        line.periodStart && line.periodEnd
          ? { 'BT-134': line.periodStart, 'BT-135': line.periodEnd }
          : null,
      'BG-27':
        lineAllowance !== 0
          ? [{ 'BT-136': centsToDecimal(lineAllowance), 'BT-139': lineAllowanceReason(line) }]
          : [],
      'BG-29': { 'BT-146': centsToDecimal(line.unitPriceCents) },
      'BG-30': { 'BT-151': line.vatCategory, 'BT-152': basisPointsToPercent(line.vatRateBp) },
      'BG-31': { 'BT-153': line.description },
    })
  })

  // Ventilation de TVA (BG-23) : par catégorie et par taux, remises comprises.
  const groups = new Map<string, En16931Invoice['BG-23'][number] & { base: number; tax: number }>()
  for (const line of ordered) {
    const key = `${line.vatCategory}|${line.vatRateBp}`
    const group = groups.get(key) ?? {
      'BT-116': '',
      'BT-117': '',
      'BT-118': line.vatCategory,
      'BT-119': basisPointsToPercent(line.vatRateBp),
      'BT-120': null,
      base: 0,
      tax: 0,
    }
    group.base += line.netAmountCents ?? 0
    group.tax += line.vatAmountCents
    group['BT-120'] ??= blank(line.vatExemptionReason)
    groups.set(key, group)
  }
  const breakdown = [...groups.values()].map(({ base, tax, ...group }) => ({
    ...group,
    'BT-116': centsToDecimal(base),
    'BT-117': centsToDecimal(tax),
  }))

  const notes: En16931Invoice['BG-1'] = []
  if (mentions) {
    // Codes de sujet des notes de la norme française (XP Z12-012) : pénalités,
    // indemnité forfaitaire, escompte.
    notes.push({ 'BT-21': 'PMD', 'BT-22': mentions.latePaymentPenaltyText })
    notes.push({
      'BT-21': 'PMT',
      'BT-22': `Indemnité forfaitaire pour frais de recouvrement : ${frenchAmount(mentions.recoveryIndemnityCents)}.`,
    })
    notes.push({ 'BT-21': 'AAB', 'BT-22': mentions.earlyPaymentDiscountText })
    if (mentions.vatOnDebits) {
      notes.push({ 'BT-21': 'TXD', 'BT-22': 'Option pour le paiement de la taxe d’après les débits.' })
    }
    if (mentions.footerText) notes.push({ 'BT-21': null, 'BT-22': mentions.footerText })
  }
  if (blank(invoice.notes)) notes.push({ 'BT-21': null, 'BT-22': invoice.notes as string })

  const means = paymentMeansCodes[invoice.expectedPaymentMethod]
  const terms = mentions?.paymentTermsDays ?? invoice.paymentTermsDays

  return {
    'BT-24': EN16931_SPECIFICATION,
    'BT-1': invoice.number,
    'BT-2': invoice.issueDate,
    'BT-3': invoice.kind === 'credit_note' ? '381' : '380',
    'BT-5': invoice.currency,
    'BT-9': invoice.dueDate,
    'BT-10': blank(invoice.buyerReference),
    'BT-20':
      terms === null || terms === undefined
        ? null
        : terms === 0
          ? 'Paiement à réception.'
          : `Paiement à ${terms} jours à compter de la date d’émission.`,
    'BG-1': notes,
    'BG-3':
      invoice.kind === 'credit_note' && source.precedingInvoice?.number
        ? [{ 'BT-25': source.precedingInvoice.number, 'BT-26': source.precedingInvoice.issueDate }]
        : [],
    'BG-4': {
      'BT-27': blank(seller?.legalName),
      'BT-30': sirenScheme(seller?.siren, '0002'),
      'BT-31': blank(seller?.vatNumber),
      'BT-33': seller ? sellerLegalInformation(seller) : null,
      'BT-34': sirenScheme(seller?.siren, '0225'),
      'BG-5': {
        'BT-35': blank(seller?.addressLine1),
        'BT-36': blank(seller?.addressLine2),
        'BT-37': blank(seller?.city),
        'BT-38': blank(seller?.postalCode),
        'BT-40': blank(seller?.country),
      },
      'BG-6': { 'BT-42': blank(seller?.phone), 'BT-43': blank(seller?.email) },
    },
    'BG-7': {
      'BT-44': blank(buyer?.name),
      'BT-47': sirenScheme(buyer?.siren, '0002'),
      'BT-48': blank(buyer?.vatNumber),
      'BT-49': sirenScheme(buyer?.siren, '0225'),
      'BG-8': {
        'BT-35': blank(buyer?.addressLine1),
        'BT-36': blank(buyer?.addressLine2),
        'BT-37': blank(buyer?.city),
        'BT-38': blank(buyer?.postalCode),
        'BT-40': blank(buyer?.country),
      },
    },
    'BG-14': { 'BT-73': invoice.periodStart, 'BT-74': invoice.periodEnd },
    'BG-16': {
      'BT-81': means.code,
      'BT-82': means.label,
      'BT-83': invoice.number,
      'BG-17':
        invoice.expectedPaymentMethod === 'transfer'
          ? { 'BT-84': blank(seller?.bankIban), 'BT-86': blank(seller?.bankBic) }
          : null,
      'BG-19':
        invoice.expectedPaymentMethod === 'direct_debit'
          ? { 'BT-89': blank(invoice.mandateReference), 'BT-90': blank(seller?.sepaCreditorId) }
          : null,
    },
    'BG-20': allowances,
    'BG-22': {
      'BT-106': centsToDecimal(lineTotal),
      'BT-107': centsToDecimal(allowanceTotal),
      'BT-108': centsToDecimal(0),
      'BT-109': centsToDecimal(invoice.totalExclTaxCents),
      'BT-110': centsToDecimal(invoice.totalTaxCents),
      'BT-112': centsToDecimal(invoice.totalInclTaxCents),
      'BT-113': centsToDecimal(0),
      'BT-114': centsToDecimal(0),
      'BT-115': centsToDecimal(invoice.totalInclTaxCents),
    },
    'BG-23': breakdown,
    'BG-25': lines,
  }
}

/* ------------------------------------------------------------------------- */
/* Vérification de complétude                                                */
/* ------------------------------------------------------------------------- */

export type En16931Check = {
  /** Terme ou règle de la norme : « BT-30 », « BR-CO-15 ». */
  term: string
  label: string
  ok: boolean
  /** Ce qu'il faut faire, quand le contrôle échoue ; ou une précision. */
  detail?: string
}

function rounded(numerator: number, denominator: number): number {
  // Moitié s'éloignant de zéro, comme `round(numeric)` (ADR 023).
  const negative = numerator < 0
  const magnitude = Math.abs(numerator)
  const value = Math.floor((2 * magnitude + denominator) / (2 * denominator))
  return negative ? -value : value
}

function percentToBasisPoints(percent: string): number {
  const [whole, fraction = '00'] = percent.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
}

function addressComplete(address: Address): boolean {
  return Boolean(address['BT-35'] && address['BT-37'] && address['BT-38'] && address['BT-40'])
}

/**
 * Contrôles de complétude et de cohérence : les données obligatoires de la
 * norme et de la réforme française, puis les règles arithmétiques (BR-CO-*).
 * Rend tous les contrôles, réussis compris : l'écran les montre en liste.
 */
export function checkEn16931(doc: En16931Invoice): En16931Check[] {
  const checks: En16931Check[] = []
  const check = (term: string, label: string, ok: boolean, detail?: string) =>
    checks.push(ok ? { term, label, ok } : { term, label, ok, detail })

  const isCredit = doc['BT-3'] === '381'
  const seller = doc['BG-4']
  const buyer = doc['BG-7']
  const buyerIsFrench = buyer['BG-8']['BT-40'] === 'FR'

  check('BT-1', 'Numéro de la facture', Boolean(doc['BT-1']), 'Attribué à l’émission.')
  check('BT-2', 'Date d’émission', Boolean(doc['BT-2']), 'Posée à l’émission.')
  check('BT-5', 'Devise', /^[A-Z]{3}$/.test(doc['BT-5']))
  check('BT-27', 'Raison sociale du vendeur', Boolean(seller['BT-27']), 'À renseigner dans l’identité du centre.')
  check('BT-30', 'SIREN du vendeur', Boolean(seller['BT-30']), 'À renseigner dans l’identité du centre.')
  check(
    'BT-31',
    'Numéro de TVA intracommunautaire du vendeur',
    Boolean(seller['BT-31']),
    'À renseigner dans l’identité du centre.',
  )
  check('BG-5', 'Adresse du vendeur', addressComplete(seller['BG-5']), 'Adresse, code postal, ville et pays du centre.')
  check(
    'BT-34',
    'Adresse électronique du vendeur',
    Boolean(seller['BT-34']),
    'Dérivée du SIREN du centre ; à confirmer à l’inscription à l’annuaire.',
  )
  check('BT-44', 'Nom de l’acheteur', Boolean(buyer['BT-44']))
  check('BG-8', 'Adresse de l’acheteur', addressComplete(buyer['BG-8']), 'Adresse, code postal, ville et pays du client.')
  check(
    'BT-47',
    'SIREN de l’acheteur',
    !buyerIsFrench || Boolean(buyer['BT-47']),
    'Obligatoire pour une entreprise française : renseignez le SIRET sur la fiche client avant d’émettre.',
  )
  check(
    'BT-49',
    'Adresse électronique de l’acheteur',
    !buyerIsFrench || Boolean(buyer['BT-49']),
    'Dérivée du SIREN du client : renseignez son SIRET.',
  )
  check(
    'BG-14',
    'Période de facturation (date de la prestation)',
    Boolean(doc['BG-14']['BT-73'] && doc['BG-14']['BT-74']),
  )
  const due = decimalToCents(doc['BG-22']['BT-115'])
  check(
    'BR-CO-25',
    'Échéance ou conditions de paiement',
    due <= 0 || Boolean(doc['BT-9'] || doc['BT-20']),
    'Une facture à payer porte son échéance.',
  )

  const means = doc['BG-16']
  if (means['BG-17']) {
    check('BT-84', 'IBAN du vendeur (virement)', Boolean(means['BG-17']['BT-84']), 'À renseigner dans l’identité du centre.')
  }
  if (means['BG-19']) {
    check('BT-89', 'Référence du mandat (prélèvement)', Boolean(means['BG-19']['BT-89']))
    check(
      'BT-90',
      'Identifiant créancier SEPA',
      Boolean(means['BG-19']['BT-90']),
      'À renseigner dans l’identité du centre.',
    )
  }

  const noteCodes = new Set(doc['BG-1'].map((note) => note['BT-21']))
  check('BG-1 PMD', 'Mention des pénalités de retard', noteCodes.has('PMD'))
  check('BG-1 PMT', 'Mention de l’indemnité forfaitaire de recouvrement', noteCodes.has('PMT'))
  check('BG-1 AAB', 'Mention de l’escompte', noteCodes.has('AAB'))
  if (isCredit) {
    check('BT-25', 'Référence de la facture rectifiée', doc['BG-3'].length > 0)
  }

  check('BG-25', 'Au moins une ligne', doc['BG-25'].length > 0)
  const incomplete = doc['BG-25'].filter(
    (line) =>
      !line['BG-31']['BT-153'].trim() ||
      Number(line['BT-129']) <= 0 ||
      !line['BT-130'] ||
      decimalToCents(line['BG-29']['BT-146']) < 0 ||
      decimalToCents(line['BT-131']) < 0,
  )
  check(
    'BG-25',
    'Lignes complètes : désignation, quantité, unité, prix et montant positifs',
    incomplete.length === 0,
    `Ligne${incomplete.length > 1 ? 's' : ''} ${incomplete.map((line) => line['BT-126']).join(', ')}.`,
  )
  const exempted = doc['BG-23'].filter((group) => group['BT-118'] !== 'S' && !group['BT-120'])
  check(
    'BT-120',
    'Motif d’exonération de TVA',
    exempted.length === 0,
    'Une ligne hors taux normal porte son motif d’exonération.',
  )

  // Règles arithmétiques (EN 16931, BR-CO-*), au centime.
  const totals = doc['BG-22']
  const cents = (amount: Amount) => decimalToCents(amount)
  const lineSum = doc['BG-25'].reduce((total, line) => total + cents(line['BT-131']), 0)
  const allowanceSum = doc['BG-20'].reduce((total, allowance) => total + cents(allowance['BT-92']), 0)
  const vatSum = doc['BG-23'].reduce((total, group) => total + cents(group['BT-117']), 0)
  check('BR-CO-10', 'Total des lignes = somme des montants nets', cents(totals['BT-106']) === lineSum)
  check('BR-CO-11', 'Total des remises = somme des remises', cents(totals['BT-107']) === allowanceSum)
  check(
    'BR-CO-13',
    'Total HT = lignes − remises + frais',
    cents(totals['BT-109']) === cents(totals['BT-106']) - cents(totals['BT-107']) + cents(totals['BT-108']),
  )
  check('BR-CO-14', 'Total TVA = somme de la ventilation', cents(totals['BT-110']) === vatSum)
  check(
    'BR-CO-15',
    'Total TTC = HT + TVA',
    cents(totals['BT-112']) === cents(totals['BT-109']) + cents(totals['BT-110']),
  )
  check(
    'BR-CO-16',
    'Net à payer = TTC − acomptes + arrondi',
    cents(totals['BT-115']) === cents(totals['BT-112']) - cents(totals['BT-113']) + cents(totals['BT-114']),
  )
  const wrongVat = doc['BG-23'].filter(
    (group) =>
      cents(group['BT-117']) !==
      rounded(cents(group['BT-116']) * percentToBasisPoints(group['BT-119']), 10_000),
  )
  check(
    'BR-CO-17',
    'TVA de chaque taux = base × taux, arrondie au centime',
    wrongVat.length === 0,
    wrongVat.map((group) => `${group['BT-118']} ${group['BT-119']} %`).join(', '),
  )
  return checks
}

/** Bilan des contrôles : complet, ou le nombre de manques. */
export function en16931Summary(checks: readonly En16931Check[]): { complete: boolean; failures: number } {
  const failures = checks.filter((check) => !check.ok).length
  return { complete: failures === 0, failures }
}
