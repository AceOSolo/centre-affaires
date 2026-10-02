import {
  paymentMethods,
  prorataRules,
  recurringBillingTimings,
  type NewTenant,
  type PaymentMethod,
  type ProrataRule,
  type RecurringBillingTiming,
  type Tenant,
} from '../../db/tenants.ts'
import { isValidIban, normalizeIban } from './iban.ts'
import {
  basisPointsToInput,
  centsToInput,
  parseAmountToCents,
  parsePercentToBasisPoints,
} from './tarifs.ts'

/**
 * Paramètres du centre éditables à l'écran de configuration (R10, ADR 023,
 * ADR 026, ADR 027) : règles tarifaires, règles de facturation, identité
 * légale et coordonnées bancaires du vendeur.
 *
 * Module pur : chaque section se lit et se valide ici, avec un message par
 * champ, avant que l'action serveur n'écrive. Les bornes reprennent les
 * contraintes de `tenants`, qui restent l'autorité.
 */

/** Saisie brute d'un formulaire : nom du champ → valeur texte. */
export type SettingsInput = Record<string, string | undefined>

export type SettingsResult =
  | { ok: true; update: Partial<NewTenant> }
  | { ok: false; fieldErrors: Record<string, string> }

const read = (input: SettingsInput, key: string) => (input[key] ?? '').trim()

/** Entier saisi dans une borne, ou `undefined`. */
function integerIn(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return number >= min && number <= max ? number : undefined
}

function finish(fieldErrors: Record<string, string>, update: Partial<NewTenant>): SettingsResult {
  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, update }
}

/* ------------------------------------------------------------------------ */
/* Règles tarifaires (ADR 023)                                              */
/* ------------------------------------------------------------------------ */

export function parsePricingRules(input: SettingsInput): SettingsResult {
  const fieldErrors: Record<string, string> = {}
  const prorataRule = read(input, 'prorataRule')
  const tolerance = integerIn(read(input, 'startedUnitToleranceMinutes'), 0, 59)
  const halfDay = integerIn(read(input, 'halfDayMinutes'), 60, 720)
  const vat = parsePercentToBasisPoints(read(input, 'defaultVatRate'))

  if (!(prorataRules as readonly string[]).includes(prorataRule)) {
    fieldErrors.prorataRule = 'Choisissez une règle de prorata.'
  }
  if (tolerance === undefined) fieldErrors.startedUnitToleranceMinutes = 'Un nombre entier de minutes, de 0 à 59.'
  if (halfDay === undefined) fieldErrors.halfDayMinutes = 'Un nombre entier de minutes, de 60 (1 h) à 720 (12 h).'
  if (vat === undefined) fieldErrors.defaultVatRate = 'Un taux de 0 à 100 %, deux décimales au plus. Exemple : 20 ou 5,5'

  return finish(fieldErrors, {
    prorataRule: prorataRule as ProrataRule,
    startedUnitToleranceMinutes: tolerance,
    halfDayMinutes: halfDay,
    defaultVatRateBp: vat,
  })
}

/* ------------------------------------------------------------------------ */
/* Facturation (ADR 026)                                                    */
/* ------------------------------------------------------------------------ */

export function parseInvoicingRules(input: SettingsInput): SettingsResult {
  const fieldErrors: Record<string, string> = {}
  const terms = integerIn(read(input, 'invoicePaymentTermsDays'), 0, 60)
  const timing = read(input, 'recurringBillingTiming')
  const penalty = read(input, 'latePaymentPenaltyText')
  const indemnity = parseAmountToCents(read(input, 'recoveryIndemnity'))
  const discount = read(input, 'earlyPaymentDiscountText')
  const footer = read(input, 'invoiceFooterText')

  // Soixante jours après l'émission : plafond légal (art. L. 441-10 du Code de commerce).
  if (terms === undefined) fieldErrors.invoicePaymentTermsDays = 'Un nombre entier de jours, de 0 à 60 (plafond légal).'
  if (!(recurringBillingTimings as readonly string[]).includes(timing)) {
    fieldErrors.recurringBillingTiming = 'Choisissez à échoir ou terme échu.'
  }
  if (!penalty) fieldErrors.latePaymentPenaltyText = 'Mention obligatoire sur toute facture : indiquez le taux des pénalités.'
  if (indemnity === undefined) fieldErrors.recoveryIndemnity = 'Montant illisible. Exemple : 40,00'
  if (!discount) fieldErrors.earlyPaymentDiscountText = 'Mention obligatoire : indiquez les conditions d’escompte, ou leur absence.'

  return finish(fieldErrors, {
    invoicePaymentTermsDays: terms,
    recurringBillingTiming: timing as RecurringBillingTiming,
    vatOnDebits: input.vatOnDebits === 'on',
    latePaymentPenaltyText: penalty,
    recoveryIndemnityCents: indemnity,
    earlyPaymentDiscountText: discount,
    invoiceFooterText: footer || null,
  })
}

/* ------------------------------------------------------------------------ */
/* Identité légale du vendeur (ADR 026)                                     */
/* ------------------------------------------------------------------------ */

/** Clé de Luhn, celle du SIREN et du SIRET. */
function luhn(digits: string): boolean {
  let total = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    total += digit
  }
  return total % 10 === 0
}

/** SIREN : neuf chiffres, clé de Luhn. */
export function isValidSiren(value: string): boolean {
  return /^\d{9}$/.test(value) && luhn(value)
}

/** SIREN de La Poste : ses établissements dérogent à la clé de Luhn. */
const LA_POSTE_SIREN = '356000000'

/** SIRET : quatorze chiffres, clé de Luhn (La Poste : somme des chiffres multiple de 5). */
export function isValidSiret(value: string): boolean {
  if (!/^\d{14}$/.test(value)) return false
  if (value.startsWith(LA_POSTE_SIREN)) {
    return [...value].reduce((total, digit) => total + Number(digit), 0) % 5 === 0
  }
  return luhn(value)
}

/** Clé du numéro de TVA français : (12 + 3 × (SIREN mod 97)) mod 97, sur deux chiffres. */
export function frenchVatKey(siren: string): string {
  return String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0')
}

/** Majuscules, sans espace ni point : la forme que la base attend. */
function compactIdentifier(value: string): string {
  return value.replace(/[\s.-]/g, '').toUpperCase()
}

/**
 * Numéro de TVA intracommunautaire. Un numéro français se vérifie entièrement :
 * `FR`, une clé de deux chiffres, le SIREN — celui du centre quand il est
 * connu. Un numéro d'un autre pays n'est contrôlé que dans sa forme.
 */
export function vatNumberProblem(value: string, siren: string | null): string | undefined {
  if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(value)) return 'Format attendu : deux lettres de pays puis le numéro. Exemple : FR44732829320'
  if (!value.startsWith('FR')) return undefined
  const match = /^FR(\d{2})(\d{9})$/.exec(value)
  if (!match) return 'Un numéro français s’écrit FR, deux chiffres de clé, puis les neuf chiffres du SIREN.'
  const [, key, vatSiren] = match
  if (siren && vatSiren !== siren) return 'Le numéro de TVA ne contient pas le SIREN du centre.'
  if (key !== frenchVatKey(vatSiren)) return 'Clé du numéro de TVA incorrecte : vérifiez la saisie.'
  return undefined
}

export function parseSellerIdentity(input: SettingsInput): SettingsResult {
  const fieldErrors: Record<string, string> = {}
  const siren = compactIdentifier(read(input, 'siren'))
  const siret = compactIdentifier(read(input, 'siret'))
  const vatNumber = compactIdentifier(read(input, 'vatNumber'))
  const capitalInput = read(input, 'shareCapital')
  const shareCapital = capitalInput ? parseAmountToCents(capitalInput) : null
  const country = read(input, 'country').toUpperCase()

  if (siren && !isValidSiren(siren)) fieldErrors.siren = 'Neuf chiffres, clé de contrôle comprise : vérifiez la saisie.'
  if (siret) {
    if (!isValidSiret(siret)) fieldErrors.siret = 'Quatorze chiffres, clé de contrôle comprise : vérifiez la saisie.'
    else if (siren && !siret.startsWith(siren)) fieldErrors.siret = 'Le SIRET commence par le SIREN du centre.'
  }
  if (vatNumber) {
    const problem = vatNumberProblem(vatNumber, isValidSiren(siren) ? siren : null)
    if (problem) fieldErrors.vatNumber = problem
  }
  if (shareCapital === undefined) fieldErrors.shareCapital = 'Montant illisible. Exemple : 10 000'
  if (!/^[A-Z]{2}$/.test(country)) fieldErrors.country = 'Code pays en deux lettres. Exemple : FR'

  return finish(fieldErrors, {
    legalName: read(input, 'legalName') || null,
    legalForm: read(input, 'legalForm') || null,
    shareCapitalCents: shareCapital,
    siren: siren || null,
    siret: siret || null,
    vatNumber: vatNumber || null,
    rcsCity: read(input, 'rcsCity') || null,
    addressLine1: read(input, 'addressLine1') || null,
    addressLine2: read(input, 'addressLine2') || null,
    postalCode: read(input, 'postalCode') || null,
    city: read(input, 'city') || null,
    country,
  })
}

/* ------------------------------------------------------------------------ */
/* Règlement (ADR 027)                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Identifiant créancier SEPA (ICS) : pays, clé, code activité (trois
 * caractères, `ZZZ` par défaut), identifiant national. La clé se calcule
 * comme celle d'un IBAN, sur l'identifiant national suivi du pays et de `00`,
 * sans le code activité.
 */
export function isValidSepaCreditorId(value: string): boolean {
  const match = /^([A-Z]{2})(\d{2})[0-9A-Z]{3}([0-9A-Z]{1,28})$/.exec(value)
  if (!match) return false
  const [, country, key, national] = match
  let remainder = 0
  for (const character of `${national}${country}00`) {
    const digits = /[0-9]/.test(character) ? character : String(character.charCodeAt(0) - 55)
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return String(98 - remainder).padStart(2, '0') === key
}

export function parseBankDetails(input: SettingsInput): SettingsResult {
  const fieldErrors: Record<string, string> = {}
  const iban = normalizeIban(read(input, 'bankIban'))
  const bic = compactIdentifier(read(input, 'bankBic'))
  const ics = compactIdentifier(read(input, 'sepaCreditorId'))
  const method = read(input, 'defaultPaymentMethod')

  if (iban && !isValidIban(iban)) fieldErrors.bankIban = 'IBAN invalide : vérifiez la saisie (clé de contrôle).'
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) fieldErrors.bankBic = 'BIC de 8 ou 11 caractères. Exemple : AGRIFRPP882'
  if (ics && !isValidSepaCreditorId(ics)) fieldErrors.sepaCreditorId = 'Identifiant créancier invalide : vérifiez la saisie. Exemple : FR72ZZZ123456'
  if (!(paymentMethods as readonly string[]).includes(method)) fieldErrors.defaultPaymentMethod = 'Choisissez un mode de paiement.'

  return finish(fieldErrors, {
    bankIban: iban || null,
    bankBic: bic || null,
    sepaCreditorId: ics || null,
    defaultPaymentMethod: method as PaymentMethod,
  })
}

/* ------------------------------------------------------------------------ */
/* Valeurs affichées dans les champs                                        */
/* ------------------------------------------------------------------------ */

/** Formes de saisie des montants et des taux : les règles uniques de `tarifs.ts`. */
export { basisPointsToInput, centsToInput }

/** Paramètres du centre, mis en forme pour les champs de l'écran de configuration. */
export function centreSettingsValues(tenant: Tenant): Record<string, string> {
  return {
    prorataRule: tenant.prorataRule,
    startedUnitToleranceMinutes: String(tenant.startedUnitToleranceMinutes),
    halfDayMinutes: String(tenant.halfDayMinutes),
    defaultVatRate: basisPointsToInput(tenant.defaultVatRateBp),
    invoicePaymentTermsDays: String(tenant.invoicePaymentTermsDays),
    recurringBillingTiming: tenant.recurringBillingTiming,
    vatOnDebits: tenant.vatOnDebits ? 'on' : '',
    latePaymentPenaltyText: tenant.latePaymentPenaltyText,
    recoveryIndemnity: centsToInput(tenant.recoveryIndemnityCents),
    earlyPaymentDiscountText: tenant.earlyPaymentDiscountText,
    invoiceFooterText: tenant.invoiceFooterText ?? '',
    legalName: tenant.legalName ?? '',
    legalForm: tenant.legalForm ?? '',
    shareCapital: tenant.shareCapitalCents === null ? '' : centsToInput(tenant.shareCapitalCents),
    siren: tenant.siren ?? '',
    siret: tenant.siret ?? '',
    vatNumber: tenant.vatNumber ?? '',
    rcsCity: tenant.rcsCity ?? '',
    addressLine1: tenant.addressLine1 ?? '',
    addressLine2: tenant.addressLine2 ?? '',
    postalCode: tenant.postalCode ?? '',
    city: tenant.city ?? '',
    country: tenant.country,
    bankIban: tenant.bankIban ?? '',
    bankBic: tenant.bankBic ?? '',
    sepaCreditorId: tenant.sepaCreditorId ?? '',
    defaultPaymentMethod: tenant.defaultPaymentMethod,
  }
}

const blank = (value: string | null) => !value || value.trim() === ''

/**
 * Identité du vendeur qu'`issue_invoice()` exige (ADR 026) : raison sociale,
 * adresse, SIREN, TVA intracommunautaire. Une seule liste, lue par l'écran de
 * configuration et par la fiche d'une facture brouillon (`missingForIssue`).
 */
export function missingSellerIdentity(
  tenant: Pick<Tenant, 'legalName' | 'addressLine1' | 'postalCode' | 'city' | 'siren' | 'vatNumber'>,
): string[] {
  const missing: string[] = []
  if (blank(tenant.legalName)) missing.push('raison sociale')
  if (blank(tenant.addressLine1) || blank(tenant.postalCode) || blank(tenant.city)) missing.push('adresse')
  if (blank(tenant.siren)) missing.push('SIREN')
  if (blank(tenant.vatNumber)) missing.push('numéro de TVA intracommunautaire')
  return missing
}

/**
 * Ce qui manque au centre pour émettre une facture — les contrôles du centre
 * dans `issue_invoice()` (ADR 026) : son identité (`missingSellerIdentity`) ;
 * l'IBAN pour un paiement par virement, l'ICS pour un prélèvement.
 */
export function missingInvoiceRequirements(
  tenant: Pick<
    Tenant,
    | 'legalName'
    | 'addressLine1'
    | 'postalCode'
    | 'city'
    | 'siren'
    | 'vatNumber'
    | 'bankIban'
    | 'sepaCreditorId'
    | 'defaultPaymentMethod'
  >,
): string[] {
  const missing = missingSellerIdentity(tenant)
  if (blank(tenant.bankIban)) missing.push('IBAN (paiement par virement)')
  if (tenant.defaultPaymentMethod === 'direct_debit' && blank(tenant.sepaCreditorId)) {
    missing.push('identifiant créancier SEPA (prélèvement)')
  }
  return missing
}
