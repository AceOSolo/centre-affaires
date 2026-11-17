'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { isCalendarDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import type { QuoteDisplay } from '../facturation/devis.ts'
import { formatCents } from '../facturation/tarifs.ts'
import {
  notifyBookingConfirmed,
  notifyBookingRequestSubmitted,
} from '../notifications/declencheurs-reservations.ts'
import { syncBookingToGoogleCalendar } from './agenda-google-queries.ts'
import { describeAttributes } from '../ressources/labels.ts'
import { parseEquipmentIds } from './options.ts'
import { periodLabel } from './periode.ts'
import {
  PortalBookingError,
  createPortalBooking,
  loadPortalPeriodAvailability,
  previewPortalQuote,
} from './portail-queries.ts'
import {
  MAX_PORTAL_NOTES_LENGTH,
  MAX_PORTAL_TITLE_LENGTH,
  expectedPortalOutcome,
  portalBookingTitle,
  portalChoiceRejection,
  portalOutcomeMessage,
  portalOutcomeNotice,
  portalRejectionMessage,
  rejectionField,
  type PortalBookingOutcome,
  type PortalPeriodField,
} from './portail-regles.ts'
import { isRentalFormula } from '../ressources/formules.ts'
import {
  choiceUnit,
  evaluateChoice,
  formulaLimitsOf,
  parseChosenFormula,
  readChoice,
  type EvaluatedChoice,
} from './formules-periode.ts'
import { periodSelection } from './public-selection.ts'
import { requestBounds } from './request-policy.ts'
import { errorsByField } from './questionnaire-fields.tsx'
import { parseAnswers, productForResourceType, type Answers } from './questionnaires.ts'

/**
 * Réservation depuis l'espace client (R23, ADR 036). Chaque action revérifie
 * le compte : une action serveur s'invoque depuis n'importe quelle page
 * (ADR 008). L'entreprise vient de la session, jamais de la requête seule :
 * celle du formulaire doit être l'une du compte.
 */

/** Un appareil proposé en option d'une salle (ADR 062), prêt à afficher. */
export type PortalEquipmentChoice = {
  id: string
  name: string
  detail: string
  /** Nul : non chiffré sur ce créneau, l'accueil précisera. */
  quote: QuoteDisplay | null
}

/** Montant et suite annoncés avant l'envoi. */
export type PortalQuoteState =
  | {
      status: 'priced'
      quote: QuoteDisplay
      fromContract: boolean
      outcome: PortalBookingOutcome
      notice: string
      equipment: PortalEquipmentChoice[]
    }
  | { status: 'unpriced'; outcome: PortalBookingOutcome; notice: string; equipment: PortalEquipmentChoice[] }
  | { status: 'error'; message: string }

export type PortalQuoteInput = {
  resourceId: string
  clientId: string
  date: string
  startTime: string
  /** Jour de fin d'une demande sur plusieurs jours (ADR 061) ; absent, le jour même. */
  endDate?: string
  endTime: string
  /** Formule de location choisie (ADR 076) : son unité fait le prix ; absente, le formulaire libre. */
  formula?: string
}

export async function previewPortalBookingAction(input: PortalQuoteInput): Promise<PortalQuoteState> {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const selection = periodSelection(input.date, input.startTime, input.endDate || input.date, input.endTime, tenant.timezone)
  if (!selection) return { status: 'error', message: portalRejectionMessage('creneau-illisible', 1) }
  const formula = isRentalFormula(input.formula) ? input.formula : 'libre'
  const preview = await previewPortalQuote(accounts, {
    clientId: input.clientId,
    resourceId: input.resourceId,
    ...selection,
    unit: choiceUnit(formula),
  })
  if (!preview) {
    return { status: 'error', message: 'Cet espace ne se réserve pas depuis votre espace client.' }
  }
  const outcome = expectedPortalOutcome(preview.mode, preview.quote !== null)
  const notice = portalOutcomeNotice(preview.mode, preview.quote !== null)
  // Le matériel libre sur ce créneau, pour une salle (ADR 062) : son nom, ce
  // qu'il est, son prix — rien de ce qui occupe les autres.
  const equipment = preview.equipment.map((device) => ({
    id: device.id,
    name: device.name,
    detail: describeAttributes(device.attributes ?? {}),
    quote: device.quote,
  }))
  return preview.quote
    ? { status: 'priced', quote: preview.quote, fromContract: preview.fromContract, outcome, notice, equipment }
    : { status: 'unpriced', outcome, notice, equipment }
}

export type PortalBookingFields = 'clientId' | PortalPeriodField | 'title' | 'notes'

export type PortalBookingFormState =
  | { status: 'idle' }
  | {
      status: 'error'
      message?: string
      fieldErrors?: Partial<Record<PortalBookingFields, string>>
      /** Réponses au questionnaire du produit refusées, par nom de champ (ADR 043). */
      answerErrors?: Record<string, string>
      /** Réponses lues, rendues au formulaire : React le vide après l'envoi. */
      answers?: Answers
    }
  | {
      status: 'done'
      bookingId: string
      outcome: PortalBookingOutcome
      title: string
      body: string
      /** Montant TTC figé, ou nul pour un créneau non chiffré. */
      amount: string | null
      /** Le matériel réservé avec la salle (ADR 062), et ce que la base en a fait. */
      options: { name: string; outcome: PortalBookingOutcome }[]
    }

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/**
 * Réserve, ou demande, selon le réglage de la ressource : la base pose le
 * statut, l'écran dit lequel des deux s'est produit.
 */
export async function bookFromPortalAction(
  _previous: PortalBookingFormState,
  formData: FormData,
): Promise<PortalBookingFormState> {
  const { user, accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const now = new Date()

  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')
  const clientId = text(formData, 'clientId')
  const title = text(formData, 'title')
  const notes = text(formData, 'notes')
  const fieldErrors: Partial<Record<PortalBookingFields, string>> = {}

  const account =
    accounts.find((candidate) => candidate.clientId === clientId) ??
    (accounts.length === 1 && !clientId ? accounts[0] : undefined)
  if (!account) fieldErrors.clientId = 'Choisissez l’entreprise pour laquelle vous réservez.'
  if (title.length > MAX_PORTAL_TITLE_LENGTH) {
    fieldErrors.title = `${MAX_PORTAL_TITLE_LENGTH} caractères au plus.`
  }
  if (notes.length > MAX_PORTAL_NOTES_LENGTH) {
    fieldErrors.notes = `${MAX_PORTAL_NOTES_LENGTH} caractères au plus.`
  }
  if (!isUuid(resourceId) || !isCalendarDate(date)) {
    return { status: 'error', message: 'Choisissez un espace dans la liste des disponibilités.' }
  }

  // Les disponibilités sont relues, sur toute la période : le formulaire a pu
  // rester ouvert pendant qu'un autre client réservait.
  const limits = formulaLimitsOf(tenant)
  const availability = await loadPortalPeriodAvailability(accounts, {
    resourceId,
    firstDate: date,
    timeZone,
    maxDaysSettings: tenant.bookingMaxDays,
    limits,
  })
  if (!availability) {
    return {
      status: 'error',
      message: 'Cet espace ne se réserve plus depuis votre espace client ce jour-là. Contactez le centre.',
    }
  }
  // La formule choisie (ADR 076), parmi celles réglées sur l'espace, et sa période.
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
  const selection = evaluation.range
  const rejection = portalChoiceRejection(evaluation, tenant, now)
  if (rejection) {
    fieldErrors[rejectionField(rejection)] = portalRejectionMessage(rejection, availability.maxDays, limits)
    // Pris entre-temps : les horaires proposés sont relus.
    if (rejection === 'creneau-indisponible') revalidatePath('/compte/reservations', 'layout')
  }
  // Les questions du produit de l'espace (ADR 043) : celui de la ressource
  // relue en base, jamais celui qu'annoncerait le formulaire.
  const product = productForResourceType(availability.resource.resourceType)
  const parsed = product ? parseAnswers(product, formData) : undefined
  const answerErrors = parsed ? errorsByField(parsed.errors) : {}
  if (Object.keys(fieldErrors).length > 0 || Object.keys(answerErrors).length > 0 || !account || !selection) {
    return { status: 'error', fieldErrors, answerErrors, answers: parsed?.answers }
  }

  // Le matériel coché (ADR 062) ; la base dit s'il est encore libre.
  const equipmentIds = parseEquipmentIds(formData.getAll('equipmentIds'))

  let created
  try {
    created = await createPortalBooking({
      account,
      accounts,
      resourceId,
      startsAt: selection.startsAt,
      endsAt: selection.endsAt,
      title: portalBookingTitle(title, account.clientName),
      notes: notes || null,
      proposal:
        product && parsed
          ? { product, answers: parsed.answers, requesterName: user.name, requesterEmail: user.email, timeZone }
          : undefined,
      equipmentIds,
      // Le prix suit l'unité de la formule choisie (ADR 076).
      unit: formula ? choiceUnit(formula) : undefined,
    })
  } catch (error) {
    if (error instanceof PortalBookingError) {
      if (error.reason !== 'conflit') return { status: 'error', message: error.message, answers: parsed?.answers }
      // Les horaires proposés sont relus : le créneau pris n'y figure plus.
      revalidatePath('/compte/reservations', 'layout')
      return { status: 'error', fieldErrors: { startTime: error.message }, answers: parsed?.answers }
    }
    throw error
  }

  const bookingId = created.id
  // Chaque appareil confirmé s'écrit dans son agenda Google (ADR 014).
  for (const option of created.options) {
    if (option.status === 'confirmed') after(() => syncBookingToGoogleCalendar(option.id))
  }
  if (created.status === 'confirmed') {
    // Écrite dans l'agenda Google de la ressource, après la réponse (ADR 014),
    // et confirmée par courriel à la personne (`booking_confirmed`, ADR 038).
    after(() => syncBookingToGoogleCalendar(bookingId))
    after(() => notifyBookingConfirmed(bookingId))
  } else {
    // L'accueil est prévenu qu'un créneau attend sa réponse (ADR 038).
    after(() => notifyBookingRequestSubmitted(bookingId))
  }
  revalidatePath('/compte/reservations', 'layout')
  revalidatePath('/reservations', 'layout')
  revalidatePath('/demandes')
  revalidatePath('/devis')
  revalidatePath('/')

  const when = periodLabel(selection, timeZone)
  const message = portalOutcomeMessage(created.status, {
    resourceName: availability.resource.name,
    when,
  })
  return {
    status: 'done',
    bookingId,
    outcome: created.status,
    ...message,
    amount: created.quote ? formatCents(created.quote.totalCents, created.quote.currency) : null,
    options: created.options.map((option) => ({
      name: option.name,
      outcome: option.status,
    })),
  }
}
