'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { isCalendarDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { requireClientAccount } from '../clients/session.ts'
import { toQuoteDisplay, type QuoteDisplay } from '../facturation/devis.ts'
import { quote } from '../facturation/devis-queries.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { notifyBookingChangedByClient } from '../notifications/declencheurs-reservations-client.ts'
import { formulasOf, isRentalFormula } from '../ressources/formules.ts'
import { syncBookingToGoogleCalendar } from './agenda-google-queries.ts'
import { changeRefusal, findBookingForChange, modifyBookingForAccounts } from './compte-modification-queries.ts'
import {
  choiceUnit,
  evaluateChoice,
  formulaLimitsOf,
  parseChosenFormula,
  readChoice,
  type EvaluatedChoice,
} from './formules-periode.ts'
import { periodLabel } from './periode.ts'
import { loadPortalPeriodAvailability } from './portail-queries.ts'
import { portalChoiceRejection, portalRejectionMessage, rejectionField, type PortalPeriodField } from './portail-regles.ts'
import { periodSelection } from './public-selection.ts'
import { requestBounds } from './request-policy.ts'

/**
 * Modification d'une demande ou d'une réservation depuis l'espace client
 * (ADR 076). Chaque action revérifie le compte : une action serveur
 * s'invoque depuis n'importe quelle page (ADR 008). La réservation doit être
 * celle d'une entreprise du compte, jamais déduite de la seule requête.
 */

export type ModificationQuoteState =
  | { status: 'priced'; quote: QuoteDisplay }
  | { status: 'unpriced'; message: string }

/** Montant des nouvelles dates, avant l'envoi : le calcul qui le figera, à l'unité de la formule. */
export async function previewModificationAction(input: {
  bookingId: string
  date: string
  startTime: string
  endDate: string
  endTime: string
  formula: string
}): Promise<ModificationQuoteState> {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const booking = await findBookingForChange(accounts, input.bookingId)
  const selection = periodSelection(input.date, input.startTime, input.endDate || input.date, input.endTime, tenant.timezone)
  if (!booking || !selection) return { status: 'unpriced', message: 'Choisissez de nouvelles dates pour connaître le montant.' }
  const formula = isRentalFormula(input.formula) && formulasOf(booking.resource).includes(input.formula) ? input.formula : 'libre'
  const result = await quote({ resourceId: booking.resource.id, ...selection, clientId: booking.clientId, unit: choiceUnit(formula) })
  return result.ok
    ? { status: 'priced', quote: toQuoteDisplay(result.quote) }
    : { status: 'unpriced', message: 'Tarif communiqué par l’accueil : il vous le précisera à la validation.' }
}

export type ModificationFormState =
  | { status: 'idle' }
  | { status: 'error'; message?: string; fieldErrors?: Partial<Record<PortalPeriodField, string>> }
  | { status: 'done'; title: string; body: string; amount: string | null }

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export async function modifyClientBookingAction(
  _previous: ModificationFormState,
  formData: FormData,
): Promise<ModificationFormState> {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const now = new Date()
  const id = text(formData, 'bookingId')
  const date = text(formData, 'date')

  const booking = await findBookingForChange(accounts, id)
  if (!booking) return { status: 'error', message: 'Cette réservation n’est pas l’une des vôtres, ou n’existe plus.' }
  const refusal = changeRefusal(booking, now)
  if (refusal) return { status: 'error', message: refusal }
  if (!isCalendarDate(date)) return { status: 'error', fieldErrors: { startTime: 'Choisissez le jour de l’arrivée.' } }

  // Disponibilités fraîches, sans la réservation elle-même : elle ne se gêne pas.
  const limits = formulaLimitsOf(tenant)
  const availability = await loadPortalPeriodAvailability(accounts, {
    resourceId: booking.resource.id,
    firstDate: date,
    timeZone,
    maxDaysSettings: tenant.bookingMaxDays,
    limits,
    excludeBookingId: booking.id,
  })
  if (!availability) {
    return { status: 'error', message: 'Cet espace ne se réserve plus depuis votre espace client. Contactez le centre.' }
  }
  const formula = parseChosenFormula(formData.get('formula'), availability.formulas)
  const evaluation: EvaluatedChoice = formula
    ? evaluateChoice(
        readChoice(formData, formula, date),
        {
          date,
          timeZone,
          availability: availability.period,
          earliest: requestBounds(tenant, now).earliest,
          maxDays: availability.maxDays,
          limits,
        },
        availability.formulas,
      )
    : { rejection: 'formule-indisponible' }
  const rejection = portalChoiceRejection(evaluation, tenant, now)
  if (rejection || !evaluation.range || !formula) {
    const reason = rejection ?? 'creneau-illisible'
    return {
      status: 'error',
      fieldErrors: { [rejectionField(reason)]: portalRejectionMessage(reason, availability.maxDays, limits) },
    }
  }

  const outcome = await modifyBookingForAccounts({
    id: booking.id,
    accounts,
    startsAt: evaluation.range.startsAt,
    endsAt: evaluation.range.endsAt,
    unit: choiceUnit(formula),
    timeZone,
  })
  if (!outcome.ok) {
    if (outcome.reason === 'conflit') {
      revalidatePath(`/compte/reservations/${booking.id}/modifier`)
      return { status: 'error', fieldErrors: { startTime: outcome.message } }
    }
    return { status: 'error', message: outcome.message }
  }

  // L'accueil est prévenu ; une réservation qui était confirmée sort de
  // l'agenda Google de la ressource tant qu'elle attend (ADR 014).
  after(() => notifyBookingChangedByClient(booking.id, outcome.memberId, outcome.previous))
  if (outcome.wasConfirmed) after(() => syncBookingToGoogleCalendar(booking.id))
  revalidatePath('/compte/reservations', 'layout')
  revalidatePath('/reservations', 'layout')
  revalidatePath('/demandes')
  revalidatePath('/devis')
  revalidatePath('/')

  return {
    status: 'done',
    title: 'Modification envoyée à l’accueil',
    body: `« ${booking.resource.name} » ${periodLabel(evaluation.range, timeZone)}. ${
      outcome.wasConfirmed
        ? 'Votre réservation repasse en attente : l’accueil valide les nouvelles dates, le créneau vous est bloqué en attendant.'
        : 'Votre demande attend toujours la validation de l’accueil, aux nouvelles dates.'
    }`,
    amount: outcome.quote ? formatCents(outcome.quote.totalCents, outcome.quote.currency) : null,
  }
}
