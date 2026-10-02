'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { formatLongDate, formatTime, isCalendarDate, toIsoDate } from '../../lib/dates.ts'
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
import {
  PortalBookingError,
  createPortalBooking,
  listPortalDayAvailability,
  previewPortalQuote,
} from './portail-queries.ts'
import {
  MAX_PORTAL_NOTES_LENGTH,
  MAX_PORTAL_TITLE_LENGTH,
  expectedPortalOutcome,
  portalBookingRejection,
  portalBookingTitle,
  portalOutcomeMessage,
  portalOutcomeNotice,
  portalRejectionMessages,
  type PortalBookingOutcome,
} from './portail-regles.ts'
import { publicSelection } from './public-selection.ts'
import { requestableRanges } from './request-policy.ts'

/**
 * Réservation depuis l'espace client (R23, ADR 036). Chaque action revérifie
 * le compte : une action serveur s'invoque depuis n'importe quelle page
 * (ADR 008). L'entreprise vient de la session, jamais de la requête seule :
 * celle du formulaire doit être l'une du compte.
 */

/** Montant et suite annoncés avant l'envoi. */
export type PortalQuoteState =
  | {
      status: 'priced'
      quote: QuoteDisplay
      fromContract: boolean
      outcome: PortalBookingOutcome
      notice: string
    }
  | { status: 'unpriced'; outcome: PortalBookingOutcome; notice: string }
  | { status: 'error'; message: string }

export type PortalQuoteInput = {
  resourceId: string
  clientId: string
  date: string
  startTime: string
  endTime: string
}

export async function previewPortalBookingAction(input: PortalQuoteInput): Promise<PortalQuoteState> {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const selection = publicSelection(input.date, input.startTime, input.endTime, tenant.timezone)
  if (!selection) return { status: 'error', message: portalRejectionMessages['creneau-illisible'] }
  const preview = await previewPortalQuote(accounts, {
    clientId: input.clientId,
    resourceId: input.resourceId,
    ...selection,
  })
  if (!preview) {
    return { status: 'error', message: 'Cet espace ne se réserve pas depuis votre espace client.' }
  }
  const outcome = expectedPortalOutcome(preview.mode, preview.quote !== null)
  const notice = portalOutcomeNotice(preview.mode, preview.quote !== null)
  return preview.quote
    ? { status: 'priced', quote: preview.quote, fromContract: preview.fromContract, outcome, notice }
    : { status: 'unpriced', outcome, notice }
}

export type PortalBookingFields = 'clientId' | 'startTime' | 'endTime' | 'title' | 'notes'

export type PortalBookingFormState =
  | { status: 'idle' }
  | {
      status: 'error'
      message?: string
      fieldErrors?: Partial<Record<PortalBookingFields, string>>
    }
  | {
      status: 'done'
      bookingId: string
      outcome: PortalBookingOutcome
      title: string
      body: string
      /** Montant TTC figé, ou nul pour un créneau non chiffré. */
      amount: string | null
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
  const { accounts } = await requireClientAccount()
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

  const selection = publicSelection(date, text(formData, 'startTime'), text(formData, 'endTime'), timeZone)
  // Les disponibilités sont relues : le formulaire a pu rester ouvert pendant
  // qu'un autre client réservait.
  const availability = (await listPortalDayAvailability(accounts, date, timeZone)).find(
    ({ resource }) => resource.id === resourceId,
  )
  if (!availability) {
    return {
      status: 'error',
      message: 'Cet espace ne se réserve plus depuis votre espace client ce jour-là. Contactez le centre.',
    }
  }
  const rejection = portalBookingRejection(
    selection,
    requestableRanges(availability.free, tenant, now),
    tenant,
    now,
  )
  if (rejection) {
    fieldErrors[rejection === 'duree-trop-courte' ? 'endTime' : 'startTime'] =
      portalRejectionMessages[rejection]
    // Pris entre-temps : les horaires proposés sont relus.
    if (rejection === 'creneau-indisponible') revalidatePath('/compte/reservations', 'layout')
  }
  if (Object.keys(fieldErrors).length > 0 || !account || !selection) {
    return { status: 'error', fieldErrors }
  }

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
    })
  } catch (error) {
    if (error instanceof PortalBookingError) {
      if (error.reason !== 'conflit') return { status: 'error', message: error.message }
      // Les horaires proposés sont relus : le créneau pris n'y figure plus.
      revalidatePath('/compte/reservations', 'layout')
      return { status: 'error', fieldErrors: { startTime: error.message } }
    }
    throw error
  }

  const bookingId = created.id
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
  revalidatePath('/')

  const day = formatLongDate(toIsoDate(selection.startsAt, timeZone), timeZone)
  const when = `le ${day}, de ${formatTime(selection.startsAt, timeZone)} à ${formatTime(selection.endsAt, timeZone)}`
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
  }
}
