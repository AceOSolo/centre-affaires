import { addDaysToIsoDate, formatCalendarDate } from '../../lib/dates.ts'
import { parseAmountToCents } from '../facturation/tarifs.ts'
import type { AmendmentInput, AmendmentPriceMode } from './avenants.ts'
import { isCalendarDate } from './formulaire.ts'
import { readLinesForm, type LineFormValues } from './lignes.ts'

/**
 * Lecture et contrôle du formulaire d'avenant (R12, ADR 025), sans base ni
 * Next : éprouvée seule (`avenant-formulaire.test.ts`). La base revérifie
 * tout à la signature (`CA005`) : date d'effet après le début du contrat et
 * après le dernier avenant signé, au plus tard le dernier jour, et, pour un
 * avenant de prix, après le dernier jour déjà facturé (ADR 032).
 */
export const amendmentFields = [
  'effectiveOn',
  'reason',
  'priceMode',
  'amount',
  'changesResource',
  'resourceId',
] as const
export type AmendmentField = (typeof amendmentFields)[number]

export const amendmentFieldLabels: Record<AmendmentField, string> = {
  effectiveOn: 'Date d’effet',
  reason: 'Objet de l’avenant',
  priceMode: 'Prix',
  amount: 'Nouveau montant HT',
  changesResource: 'Changer la ressource',
  resourceId: 'Nouvelle ressource',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_INTEGER = 2_147_483_647
const PRICE_MODES: readonly AmendmentPriceMode[] = ['unchanged', 'amount', 'lines']

/**
 * Date d'effet proposée pour un nouvel avenant : le premier du mois suivant,
 * mais jamais avant le lendemain du début du contrat, du dernier avenant
 * signé, ni — pour un avenant de prix — du dernier jour déjà facturé
 * (`billedThrough`) : la base refuserait (`CA005`).
 */
export function defaultEffectiveOn(
  today: string,
  startsOn: string,
  lastSignedEffectiveOn: string | null,
  billedThrough: string | null = null,
): string {
  const [year, month] = today.split('-').map(Number)
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
  const latest = [startsOn, lastSignedEffectiveOn, billedThrough].reduce<string>(
    (max, day) => (day && day > max ? day : max),
    startsOn,
  )
  const floor = addDaysToIsoDate(latest, 1)
  return nextMonth > floor ? nextMonth : floor
}

/**
 * Refus d'une date d'effet de prix sur une période déjà facturée (ADR 032) :
 * la nouvelle version serait facturée une seconde fois sur ces jours. Nul si
 * la date convient. Un avenant de ressource seule n'est pas concerné.
 */
export function billedPeriodRefusal(effectiveOn: string, billedThrough: string | null): string | null {
  if (!billedThrough || effectiveOn > billedThrough) return null
  return `Le contrat est déjà facturé jusqu’au ${formatCalendarDate(billedThrough)} : un nouveau prix prend effet au plus tôt le ${formatCalendarDate(addDaysToIsoDate(billedThrough, 1))}. Pour revenir sur une période facturée, établissez d’abord un avoir.`
}

export type AmendmentFormResult =
  | { ok: true; input: AmendmentInput }
  | {
      ok: false
      fieldErrors: Record<string, string>
      values: Record<AmendmentField, string>
      lines: LineFormValues[]
    }

/**
 * Lit un avenant : sa date d'effet, son objet, ce qu'il change. `keys` sont
 * les clés des lignes soumises (mode « nouvelles lignes ») ; `period` borne la
 * date d'effet pour un message immédiat — la base tranche de toute façon.
 * `billedThrough` : dernier jour déjà facturé du contrat (nul : rien).
 */
export function readAmendmentForm(
  read: (name: string) => string,
  keys: readonly string[],
  period: { startsOn: string; lastDay: string | null; billedThrough?: string | null },
): AmendmentFormResult {
  const values = Object.fromEntries(
    amendmentFields.map((field) => [field, (read(field) ?? '').trim()]),
  ) as Record<AmendmentField, string>
  const errors: Record<string, string> = {}

  if (!values.effectiveOn) errors.effectiveOn = 'Indiquez la date d’effet.'
  else if (!isCalendarDate(values.effectiveOn)) errors.effectiveOn = 'Date illisible.'
  else if (values.effectiveOn <= period.startsOn) {
    errors.effectiveOn =
      'La date d’effet suit le premier jour du contrat : avant son début, un contrat se modifie sans avenant.'
  } else if (period.lastDay && values.effectiveOn > period.lastDay) {
    errors.effectiveOn = 'La date d’effet dépasse le dernier jour du contrat.'
  }

  if (values.reason.length > 500) errors.reason = '500 caractères au plus.'

  const priceMode = values.priceMode as AmendmentPriceMode
  if (!PRICE_MODES.includes(priceMode)) errors.priceMode = 'Choisissez ce que devient le prix.'
  if (!errors.effectiveOn && (priceMode === 'amount' || priceMode === 'lines')) {
    const refusal = billedPeriodRefusal(values.effectiveOn, period.billedThrough ?? null)
    if (refusal) errors.effectiveOn = refusal
  }

  let amountCents: number | null = null
  if (priceMode === 'amount') {
    const cents = parseAmountToCents(values.amount)
    if (!values.amount) errors.amount = 'Indiquez le nouveau montant.'
    else if (cents === undefined) errors.amount = 'Montant illisible. Exemple : 950,00'
    else if (cents > MAX_INTEGER) errors.amount = 'Montant trop élevé.'
    else amountCents = cents
  }

  const lines = priceMode === 'lines' ? readLinesForm(keys, read) : readLinesForm([], read)
  if (!lines.ok) Object.assign(errors, lines.fieldErrors)
  if (priceMode === 'lines' && lines.ok && !lines.lines.some((line) => line.isRecurring)) {
    errors.priceMode =
      'Un avenant de prix porte au moins une ligne récurrente : ses lignes remplacent toutes les précédentes.'
  }

  const changesResource = values.changesResource === 'on'
  if (changesResource && values.resourceId && !UUID.test(values.resourceId)) {
    errors.resourceId = 'Ressource inconnue.'
  }
  if (!changesResource && priceMode === 'unchanged') {
    errors.priceMode = 'Un avenant change le prix, la ressource, ou les deux.'
  }

  if (Object.keys(errors).length > 0 || !lines.ok) {
    return { ok: false, fieldErrors: errors, values, lines: lines.values }
  }
  return {
    ok: true,
    input: {
      effectiveOn: values.effectiveOn,
      reason: values.reason || null,
      priceMode,
      amountCents,
      lines: priceMode === 'lines' ? lines.lines : [],
      changesResource,
      resourceId: changesResource ? values.resourceId || null : null,
    },
  }
}
