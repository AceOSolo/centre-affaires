import { isValidIban, normalizeIban } from './iban.ts'
import { isIsoDate } from './paiements-regles.ts'
import type { MandateField } from './reglements-labels.ts'
import type { SepaSequenceType } from './schema-factures.ts'

/**
 * Règles des mandats de prélèvement SEPA (R16, ADR 027, ADR 030).
 *
 * Module pur : la RUM, la lecture du formulaire, la caducité et le type de
 * séquence d'un prélèvement s'éprouvent seuls (`mandats-regles.test.ts`). Le
 * chiffrement de l'IBAN est dans `iban.ts`, l'écriture dans `mandats.ts`.
 *
 * Serveur seulement : `iban.ts` tire `node:crypto`. Le formulaire prend ses
 * libellés dans `reglements-labels.ts`.
 */

/**
 * Alphabet du suffixe aléatoire de la RUM : majuscules et chiffres sans les
 * caractères qui se confondent à la lecture ou à la dictée (I, O, 0, 1).
 */
const RUM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const RUM_SUFFIX_LENGTH = 6

/**
 * Référence unique de mandat (RUM) : `RUM-20261001-7KQ2XD`, 19 caractères sur
 * les 35 permis, dans le jeu de caractères SEPA.
 *
 * La date dit quand le mandat a été enregistré ; le suffixe aléatoire le rend
 * unique sans compteur à tenir. La base garantit l'unicité pour toujours dans
 * le centre (`sepa_mandates_tenant_reference_key`) : une collision, très
 * improbable, se rejoue avec un autre tirage. `bytes` vient de
 * `crypto.randomBytes` côté serveur ; il est passé en paramètre pour que ce
 * module reste pur.
 */
export function generateMandateReference(today: string, bytes: Uint8Array): string {
  if (bytes.length < RUM_SUFFIX_LENGTH) throw new RangeError('Tirage trop court pour une RUM.')
  let suffix = ''
  for (let index = 0; index < RUM_SUFFIX_LENGTH; index++) {
    suffix += RUM_ALPHABET[bytes[index] % RUM_ALPHABET.length]
  }
  return `RUM-${today.replace(/-/g, '')}-${suffix}`
}

export type MandateFieldErrors = Partial<Record<MandateField, string>>

/**
 * Valeurs rendues au formulaire après un refus. **Jamais l'IBAN** : il n'est
 * affiché en entier qu'au moment de la saisie, puis plus jamais (ADR 027).
 */
export type MandateFormValues = {
  debtorName: string
  bic: string
  signedOn: string
  sequenceType: string
}

export type MandateInput = {
  debtorName: string
  /** Forme électronique : majuscules, sans espace. */
  iban: string
  bic: string | null
  signedOn: string
  sequenceType: SepaSequenceType
}

/** Le `Nm` d'un débiteur en pain.008 : 70 caractères au plus. */
const MAX_DEBTOR_NAME = 70
const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/

export function readMandateForm(
  formData: FormData,
  { today }: { today: string },
): { input: MandateInput } | { fieldErrors: MandateFieldErrors; values: MandateFormValues } {
  const text = (key: string) => String(formData.get(key) ?? '').trim()
  const values: MandateFormValues = {
    debtorName: text('debtorName'),
    bic: text('bic').replace(/\s/g, '').toUpperCase(),
    signedOn: text('signedOn'),
    sequenceType: text('sequenceType') || 'recurrent',
  }
  const iban = normalizeIban(text('iban'))
  const errors: MandateFieldErrors = {}

  if (!values.debtorName) errors.debtorName = 'Saisissez le titulaire du compte, tel qu’il figure sur le mandat.'
  else if (values.debtorName.length > MAX_DEBTOR_NAME) {
    errors.debtorName = `${MAX_DEBTOR_NAME} caractères au plus.`
  }

  if (!iban) errors.iban = 'Saisissez l’IBAN du compte à débiter.'
  else if (!isValidIban(iban)) errors.iban = 'IBAN invalide : vérifiez la saisie (clé de contrôle).'

  if (values.bic && !BIC.test(values.bic)) {
    errors.bic = 'BIC illisible : 8 ou 11 caractères, par exemple AGRIFRPP ou AGRIFRPP882.'
  }

  if (!values.signedOn) errors.signedOn = 'Saisissez la date de signature du mandat.'
  else if (!isIsoDate(values.signedOn)) errors.signedOn = 'Date illisible.'
  else if (values.signedOn > today) errors.signedOn = 'Un mandat se saisit une fois signé : la date ne peut pas être future.'

  if (values.sequenceType !== 'recurrent' && values.sequenceType !== 'one_off') {
    errors.sequenceType = 'Choisissez récurrent ou ponctuel.'
  }

  if (Object.keys(errors).length > 0) return { fieldErrors: errors, values }
  return {
    input: {
      debtorName: values.debtorName,
      iban,
      bic: values.bic || null,
      signedOn: values.signedOn,
      sequenceType: values.sequenceType as SepaSequenceType,
    },
  }
}

/** Un mandat inutilisé pendant 36 mois devient caduc (règlement SEPA, ADR 027). */
export const MANDATE_LAPSE_MONTHS = 36

/** Ajoute des mois à un jour civil ; le 31 devient le dernier jour d'un mois plus court. */
export function addMonthsToIsoDate(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10)
}

/**
 * Le mandat est-il caduc au jour `today` ? Trente-six mois sans prélèvement
 * présenté, comptés depuis le dernier — ou depuis la signature s'il n'a jamais
 * servi.
 */
export function isMandateLapsed(
  mandate: { signedOn: string; lastCollectedOn: string | null },
  today: string,
): boolean {
  const since = mandate.lastCollectedOn ?? mandate.signedOn
  return today >= addMonthsToIsoDate(since, MANDATE_LAPSE_MONTHS)
}

/** Type de séquence d'un prélèvement SEPA (pain.008, `SeqTp`). */
export type SepaSequenceCode = 'FRST' | 'RCUR' | 'OOFF'

/**
 * `OOFF` pour un mandat ponctuel ; pour un mandat récurrent, `FRST` au
 * premier prélèvement, `RCUR` ensuite. Le règlement SEPA admet `RCUR` dès le
 * premier depuis 2016, mais `FRST` reste accepté partout : c'est le choix le
 * plus sûr d'une banque à l'autre (ADR 030).
 */
export function sepaSequenceFor(
  sequenceType: SepaSequenceType,
  collectedBefore: boolean,
): SepaSequenceCode {
  if (sequenceType === 'one_off') return 'OOFF'
  return collectedBefore ? 'RCUR' : 'FRST'
}

/**
 * Identifiant d'une remise de prélèvements (`MsgId`) : `PRLV-20261001-7KQ2XD`.
 * Il est porté par chaque paiement de la remise (`payments.reference`) et
 * permet de régénérer le fichier à l'identique ; la banque refuse un second
 * fichier sous le même identifiant, ce qui protège d'un double dépôt.
 */
export function generateRemittanceId(today: string, bytes: Uint8Array): string {
  return generateMandateReference(today, bytes).replace(/^RUM-/, 'PRLV-')
}

/** Reconnaît un identifiant de remise. */
export function isRemittanceId(value: string): boolean {
  return /^PRLV-\d{8}-[A-Z2-9]{6}$/.test(value)
}

/** Ce qu'il faut savoir d'une facture pour la prélever. */
export type DirectDebitCheck = {
  currency: string
  mandate: {
    status: 'active' | 'revoked' | 'expired'
    deleted: boolean
    sequenceType: SepaSequenceType
    signedOn: string
    lastCollectedOn: string | null
    /** Un mandat ponctuel déjà prélevé ne sert plus. */
    usedOnce: boolean
  } | null
}

/**
 * Pourquoi une facture échue ne peut pas être prélevée, ou `null` si elle le
 * peut. L'écran affiche le motif à côté de la facture, qui reste à relancer
 * par un autre moyen.
 */
export function directDebitBlocker(check: DirectDebitCheck, today: string): string | null {
  if (check.currency !== 'EUR') return 'Le prélèvement SEPA se fait en euros.'
  const { mandate } = check
  if (!mandate || mandate.deleted) return 'Aucun mandat sur cette facture.'
  if (mandate.status === 'revoked') return 'Mandat révoqué : convenez d’un autre moyen de paiement.'
  if (mandate.status === 'expired' || isMandateLapsed(mandate, today)) {
    return 'Mandat caduc (36 mois sans prélèvement) : faites signer un nouveau mandat.'
  }
  if (mandate.sequenceType === 'one_off' && mandate.usedOnce) return 'Mandat ponctuel déjà utilisé.'
  return null
}

/**
 * Date de prélèvement demandée : un jour réel, après aujourd'hui (la banque
 * reçoit le fichier au moins la veille), et dans l'année.
 */
export function checkCollectionDate(collectionDate: string, today: string): string | undefined {
  if (!isIsoDate(collectionDate)) return 'Date de prélèvement illisible.'
  if (collectionDate <= today) {
    return 'La date de prélèvement suit le dépôt du fichier : choisissez un jour après aujourd’hui.'
  }
  if (collectionDate > addMonthsToIsoDate(today, 12)) return 'La date de prélèvement est à moins d’un an.'
  return undefined
}
