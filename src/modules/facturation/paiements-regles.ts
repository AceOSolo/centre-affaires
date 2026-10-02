import type { PaymentMethod } from '../../db/tenants.ts'
import { formatCalendarDate, isCalendarDate } from '../../lib/dates.ts'
import { paymentMethodLabels } from './reglements-labels.ts'
import { formatCents, parseAmountToCents } from './tarifs.ts'

/**
 * Règles du pointage des paiements et des relances (R16, ADR 027, ADR 030).
 *
 * Module pur, sans base ni Next : il s'éprouve seul (`paiements-regles.test.ts`)
 * et se charge aussi dans le navigateur (types seuls depuis les schémas).
 * La base reste l'autorité sur ce qui s'écrit (SQLSTATE `CA006` : facture non
 * émise, avoir, autre devise) ; ces règles disent à l'équipe, avant l'écriture,
 * ce qui ne va pas dans sa saisie.
 */

const MS_PER_DAY = 86_400_000
/** Plafond d'une colonne `integer` en centimes : 21 474 836,47. */
const MAX_CENTS = 2_147_483_647

/** « 1250,10 » : un montant en centimes, tel qu'il se saisit dans un champ. */
export { centsToInput } from './tarifs.ts'

/** « 05/10/2026 » : un jour civil, sans fuseau. */
export const formatIsoDateFr = formatCalendarDate

function isoDayNumber(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / MS_PER_DAY
}

/** Jours entre deux jours civils : `to − from`, négatif si `to` précède. */
export function daysBetween(from: string, to: string): number {
  return isoDayNumber(to) - isoDayNumber(from)
}

/** Un jour civil réel, pas seulement au bon format : le 31/02 est refusé. */
export const isIsoDate = isCalendarDate

/* ------------------------------------------------------------------------- */
/* Pointage d'un paiement                                                    */
/* ------------------------------------------------------------------------- */

/** Paiement reçu, ou remboursement d'un trop-perçu (montant négatif en base). */
export const paymentDirections = ['payment', 'refund'] as const
export type PaymentDirection = (typeof paymentDirections)[number]

export type PaymentField = 'direction' | 'amount' | 'paidOn' | 'method' | 'reference' | 'notes'
export type PaymentFieldErrors = Partial<Record<PaymentField, string>>

export const paymentFieldLabels: Record<PaymentField, string> = {
  direction: 'Nature',
  amount: 'Montant',
  paidOn: 'Date de valeur',
  method: 'Mode',
  reference: 'Référence',
  notes: 'Notes',
}

/** Valeurs saisies, rendues au formulaire après un refus. */
export type PaymentFormValues = {
  direction: string
  amount: string
  paidOn: string
  method: string
  reference: string
  notes: string
  overpaymentConfirmed: boolean
}

export type PaymentInput = {
  /** Signé : positif pour un paiement, négatif pour un remboursement. */
  amountCents: number
  paidOn: string
  method: PaymentMethod
  reference: string | null
  notes: string | null
  /** Trop-perçu assumé : le montant dépasse sciemment le reste dû. */
  overpaymentConfirmed: boolean
}

const MAX_REFERENCE = 140
const MAX_NOTES = 2000

/** La saisie telle qu'envoyée, pour la rendre au formulaire après un refus. */
export function paymentFormValues(formData: FormData): PaymentFormValues {
  const text = (key: string) => String(formData.get(key) ?? '').trim()
  return {
    direction: text('direction') || 'payment',
    amount: text('amount'),
    paidOn: text('paidOn'),
    method: text('method'),
    reference: text('reference'),
    notes: text('notes'),
    overpaymentConfirmed: formData.get('overpaymentConfirmed') === 'on',
  }
}

/**
 * Lit le formulaire de pointage. Les contrôles qui dépendent de la facture
 * (reste dû, paiements reçus) viennent ensuite, dans la transaction qui
 * l'écrit : `checkPaymentAmount`.
 */
export function readPaymentForm(
  formData: FormData,
  { today }: { today: string },
): { input: PaymentInput } | { fieldErrors: PaymentFieldErrors; values: PaymentFormValues } {
  const values = paymentFormValues(formData)
  const errors: PaymentFieldErrors = {}

  if (!(paymentDirections as readonly string[]).includes(values.direction)) {
    errors.direction = 'Choisissez un paiement reçu ou un remboursement.'
  }

  const cents = values.amount ? parseAmountToCents(values.amount) : undefined
  if (!values.amount) errors.amount = 'Saisissez le montant.'
  else if (cents === undefined) errors.amount = 'Montant illisible. Exemple : 120,00'
  else if (cents === 0) errors.amount = 'Un montant nul ne se pointe pas.'
  else if (cents > MAX_CENTS) errors.amount = 'Montant trop élevé.'

  if (!values.paidOn) errors.paidOn = 'Saisissez la date de valeur.'
  else if (!isIsoDate(values.paidOn)) errors.paidOn = 'Date illisible.'
  else if (values.paidOn > today) {
    errors.paidOn = 'Un paiement se pointe une fois reçu : la date ne peut pas être future.'
  }

  if (!Object.hasOwn(paymentMethodLabels, values.method)) {
    errors.method = 'Choisissez le mode de paiement.'
  }
  if (values.reference.length > MAX_REFERENCE) {
    errors.reference = `${MAX_REFERENCE} caractères au plus.`
  } else if (/^PRLV-\d{8}-/i.test(values.reference)) {
    // Une remise de prélèvements se reconnaît à cette référence (ADR 030) :
    // un pointage à la main ne doit pas s'y glisser.
    errors.reference = 'Les références « PRLV-… » sont réservées aux remises de prélèvement préparées par l’application.'
  }
  if (values.notes.length > MAX_NOTES) errors.notes = `${MAX_NOTES} caractères au plus.`

  if (Object.keys(errors).length > 0 || cents === undefined) {
    return { fieldErrors: errors, values }
  }
  return {
    input: {
      amountCents: values.direction === 'refund' ? -cents : cents,
      paidOn: values.paidOn,
      method: values.method as PaymentMethod,
      reference: values.reference || null,
      notes: values.notes || null,
      overpaymentConfirmed: values.overpaymentConfirmed,
    },
  }
}

/**
 * Contrôle du montant face à la facture, au moment de l'écrire :
 *
 * - un paiement qui dépasse le reste dû n'est accepté que si le trop-perçu est
 *   assumé (une faute de frappe, 1 200 pour 120, se voit avant d'être
 *   enregistrée) ;
 * - un remboursement ne dépasse pas ce qui a été reçu.
 *
 * Rend le message à afficher sous le montant, ou `undefined`.
 */
export function checkPaymentAmount({
  amountCents,
  amountDueCents,
  paidCents,
  currency,
  overpaymentConfirmed,
}: {
  amountCents: number
  amountDueCents: number
  paidCents: number
  currency: string
  overpaymentConfirmed: boolean
}): string | undefined {
  if (amountCents < 0) {
    if (-amountCents > paidCents) {
      return paidCents > 0
        ? `Le remboursement dépasse les paiements reçus (${formatCents(paidCents, currency)}).`
        : 'Aucun paiement reçu sur cette facture : il n’y a rien à rembourser.'
    }
    return undefined
  }
  if (amountCents > amountDueCents && !overpaymentConfirmed) {
    return amountDueCents > 0
      ? `Le montant dépasse le reste dû (${formatCents(amountDueCents, currency)}). Cochez « Trop-perçu » pour l’enregistrer quand même.`
      : 'Cette facture est déjà réglée. Cochez « Trop-perçu » pour enregistrer ce paiement quand même.'
  }
  return undefined
}

const MAX_CANCELLATION_REASON = 500

/** Motif d'annulation d'un pointage : obligatoire, la trace compte autant que le pointage. */
export function readCancellationReason(formData: FormData): { reason: string } | { error: string } {
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: 'Indiquez le motif de l’annulation : erreur de saisie, rejet de prélèvement…' }
  if (reason.length > MAX_CANCELLATION_REASON) {
    return { error: `Motif trop long : ${MAX_CANCELLATION_REASON} caractères au plus.` }
  }
  return { reason }
}

/* ------------------------------------------------------------------------- */
/* Relances                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Paliers de relance, en jours de retard après l'échéance. **À valider par le
 * centre** (ADR 030) : une relance amiable dès le lendemain, une seconde après
 * quinze jours, une mise en demeure après trente.
 */
export const dunningSteps = [
  { level: 1, afterDays: 1, label: 'Relance amiable' },
  { level: 2, afterDays: 15, label: 'Seconde relance' },
  { level: 3, afterDays: 30, label: 'Mise en demeure' },
] as const

export type DunningLevel = 0 | 1 | 2 | 3

export const dunningLevelLabels: Record<DunningLevel, string> = {
  0: 'Pas encore échue',
  1: 'Relance amiable',
  2: 'Seconde relance',
  3: 'Mise en demeure',
}

/** Jours de retard au jour `today` : 0 tant que l'échéance n'est pas passée. */
export function daysOverdue(dueDate: string, today: string): number {
  return Math.max(0, daysBetween(dueDate, today))
}

/** Palier de relance atteint au jour `today`. Le jour de l'échéance, rien n'est dû en retard. */
export function dunningLevel(dueDate: string, today: string): DunningLevel {
  const late = daysOverdue(dueDate, today)
  let level: DunningLevel = 0
  for (const step of dunningSteps) if (late >= step.afterDays) level = step.level
  return level
}

/** « FR76 3000 6000 0112 3456 7890 189 » : l'IBAN du centre, imprimé sur une relance. */
export function formatIbanGroups(iban: string): string {
  return iban.replace(/\s/g, '').replace(/(.{4})(?=.)/g, '$1 ')
}

export type ReminderFacts = {
  /** Raison sociale du centre, ou son nom d'usage. */
  sellerName: string
  clientName: string
  invoiceNumber: string
  issueDate: string
  dueDate: string
  /** Jour de la relance, jour civil du centre. */
  today: string
  amountDueCents: number
  currency: string
  level: Exclude<DunningLevel, 0>
  expectedPaymentMethod: PaymentMethod
  bankIban: string | null
  bankBic: string | null
  latePaymentPenaltyText: string
  recoveryIndemnityCents: number
}

/**
 * Texte d'une relance : objet et corps, en français, à imprimer ou à envoyer.
 *
 * Il rappelle la facture, le reste dû, la façon de payer, et les pénalités et
 * l'indemnité forfaitaire figées dans la facture (art. L. 441-10 et D. 441-5
 * du Code de commerce). Aucun envoi automatique : l'équipe décide (ADR 030).
 */
export function reminderMessage(facts: ReminderFacts): { subject: string; text: string } {
  const amount = formatCents(facts.amountDueCents, facts.currency)
  const late = daysOverdue(facts.dueDate, facts.today)
  const invoice = `la facture ${facts.invoiceNumber} du ${formatIsoDateFr(facts.issueDate)}`

  const subject =
    facts.level === 3
      ? `Mise en demeure de payer — facture ${facts.invoiceNumber}`
      : facts.level === 2
        ? `Seconde relance — facture ${facts.invoiceNumber} impayée`
        : `Relance — facture ${facts.invoiceNumber} échue le ${formatIsoDateFr(facts.dueDate)}`

  const opening =
    facts.level === 3
      ? `Malgré nos relances, ${invoice}, échue le ${formatIsoDateFr(facts.dueDate)}, reste impayée ` +
        `${late} jours après son échéance. Nous vous mettons en demeure de régler la somme de ${amount} ` +
        'sous huit jours à compter de la réception de ce courrier.'
      : facts.level === 2
        ? `Sauf erreur de notre part, ${invoice}, échue le ${formatIsoDateFr(facts.dueDate)}, reste impayée ` +
          `${late} jours après son échéance. Le montant restant dû est de ${amount}.`
        : `Sauf erreur de notre part, ${invoice}, échue le ${formatIsoDateFr(facts.dueDate)}, n’est pas ` +
          `encore réglée. Le montant restant dû est de ${amount}.`

  const reference = `en indiquant la référence ${facts.invoiceNumber}`
  const transfer = facts.bankIban
    ? `par virement sur le compte IBAN ${formatIbanGroups(facts.bankIban)}` +
      (facts.bankBic ? ` (BIC ${facts.bankBic})` : '') +
      `, ${reference}`
    : undefined
  const howToPay =
    facts.expectedPaymentMethod === 'direct_debit'
      ? 'Le prélèvement de cette facture n’a pas abouti. ' +
        (transfer
          ? `Merci de la régler ${transfer}.`
          : 'Merci de prendre contact avec nous pour convenir de son règlement.')
      : transfer
        ? `Merci d’effectuer votre règlement ${transfer}.`
        : `Merci de nous adresser votre règlement, ${reference}.`

  const penalties =
    `${facts.latePaymentPenaltyText} ` +
    `Une indemnité forfaitaire pour frais de recouvrement de ${formatCents(facts.recoveryIndemnityCents, facts.currency)} ` +
    'est due en cas de retard de paiement (art. D. 441-5 du Code de commerce).'

  const closing =
    facts.level === 3
      ? 'À défaut de règlement dans ce délai, nous nous réservons le droit d’engager une procédure de recouvrement.'
      : 'Si votre règlement est déjà parti, merci de ne pas tenir compte de ce message.'

  const text = [
    `${facts.clientName}`,
    `Le ${formatIsoDateFr(facts.today)}`,
    '',
    'Madame, Monsieur,',
    '',
    opening,
    '',
    howToPay,
    '',
    closing,
    '',
    penalties,
    '',
    'Veuillez agréer, Madame, Monsieur, nos salutations distinguées.',
    '',
    facts.sellerName,
  ].join('\n')

  return { subject, text }
}
