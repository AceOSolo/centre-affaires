'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { DB_OPTION_REFUSED, dbErrorCode, dbSignalMessage } from '../../db/errors.ts'
import { requirePermission } from '../../lib/auth/staff.ts'

import { formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { parseQuoteDiscount } from '../facturation/devis.ts'
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingRequestAccepted,
  notifyBookingRequestRefused,
} from '../notifications/declencheurs-reservations.ts'
import { syncBookingToGoogleCalendar, syncBookingsToGoogleCalendar } from './agenda-google-queries.ts'
import { describeBusyBooking } from './occupation.ts'
import { listOptionsOf, syncOptionLinesAfterCancel } from './options-queries.ts'
import {
  BookingConflictError,
  BookingNotMovableError,
  ContractOccupationLockedError,
  InvalidRangeError,
  QuoteDiscountError,
  assignBookingClient,
  cancelBooking,
  confirmBooking,
  createBooking,
  findBooking,
  moveBooking,
  refuseBooking,
} from './queries.ts'
import { BookingContractError } from './rattachement.ts'

/**
 * État rendu au formulaire. `fieldErrors` rattache chaque erreur à son champ,
 * que le formulaire affiche à côté et reprend dans le résumé en tête ;
 * `values` lui rend la saisie, que React efface à la fin de l'envoi.
 */
export type FormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/**
 * Message rendu au staff pour les erreurs métier d'une réservation.
 *
 * Partagé par la création et le déplacement : les deux se heurtent à la même
 * contrainte d'exclusion et doivent nommer le créneau qui bloque de la même
 * façon. `undefined` signale une erreur qui n'est pas de ce ressort et qui doit
 * remonter.
 */
function describeBookingError(error: unknown, timeZone: string): string | undefined {
  if (error instanceof InvalidRangeError) return error.message
  if (error instanceof BookingNotMovableError) return error.message
  if (error instanceof ContractOccupationLockedError) return error.message
  if (error instanceof BookingContractError) return error.message
  // Matériel en option sorti de ses règles (ADR 062) : la base dit lesquelles.
  if (dbErrorCode(error) === DB_OPTION_REFUSED) return dbSignalMessage(error)
  if (error instanceof BookingConflictError) {
    const occupied = error.conflicts
      .map((conflict) =>
        // Une occupation de contrat couvre des jours entiers : « de 00:00 à
        // 00:00 » ne dirait rien (ADR 018).
        conflict.kind === 'contract'
          ? describeBusyBooking(conflict, timeZone)
          : `« ${conflict.title} » de ${formatTime(conflict.startsAt, timeZone)} à ${formatTime(conflict.endsAt, timeZone)}`,
      )
      .join(', ')
    return occupied ? `Créneau déjà pris sur cette ressource : ${occupied}.` : error.message
  }
  return undefined
}

export async function createBookingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('reservations.gerer')
  const timeZone = await currentTimeZone()
  const values = Object.fromEntries(
    [
      'date',
      'startTime',
      'endDate',
      'endTime',
      'title',
      'clientId',
      'contractId',
      'notes',
      'discountKind',
      'discountValue',
    ].map((key) => [key, text(formData, key)]),
  )
  // Usage interne : la réservation n'est pas chiffrée (R11, ADR 023).
  const internal = formData.get('internal') === 'on'
  const discount = parseQuoteDiscount(values.discountKind, values.discountValue)
  const resourceId = text(formData, 'resourceId')
  const fieldErrors: Record<string, string> = {}

  if (!resourceId) return { error: 'Choisir une ressource.', values }
  if (!values.title) fieldErrors.title = 'Indiquez l’objet de la réservation.'
  if (values.contractId && !isUuid(values.contractId)) fieldErrors.contractId = 'Contrat inconnu.'
  if (!internal && !discount.ok) fieldErrors.discountValue = discount.message

  let startsAt: Date | undefined
  let endsAt: Date | undefined
  try {
    // Le staff saisit deux jours et deux heures murales — le jour de fin est
    // celui du début sauf période sur plusieurs jours (ADR 061) ; la base
    // reçoit deux instants UTC (décision 4).
    startsAt = wallClockToUtc(`${values.date}T${values.startTime}`, timeZone)
    endsAt = wallClockToUtc(`${values.endDate || values.date}T${values.endTime}`, timeZone)
  } catch {
    fieldErrors.date = 'Date ou horaires illisibles.'
  }

  if (Object.keys(fieldErrors).length > 0 || !startsAt || !endsAt) {
    return { fieldErrors, values }
  }

  let createdId: string
  try {
    const created = await createBooking({
      resourceId,
      startsAt,
      endsAt,
      title: values.title,
      notes: values.notes || null,
      // Facultatif : la réservation apparaît alors dans l'espace du client.
      clientId: isUuid(values.clientId) ? values.clientId : null,
      // Facultatif : un contrat actif de ce client qui couvre le créneau (R05),
      // vérifié par `createBooking` dans la transaction qui écrit.
      contractId: values.contractId || null,
      // Le devis est recalculé et figé dans la transaction qui écrit : le
      // montant affiché par le formulaire n'est qu'une annonce.
      pricing: internal
        ? { mode: 'none' }
        : { mode: 'grid', discount: discount.ok ? discount.discount : null },
    })
    createdId = created.id
  } catch (error) {
    if (error instanceof InvalidRangeError) {
      return { fieldErrors: { endTime: error.message }, values }
    }
    if (error instanceof QuoteDiscountError) {
      return { fieldErrors: { discountValue: error.message }, values }
    }
    if (error instanceof BookingContractError) {
      return {
        fieldErrors:
          error.problem === 'sans-client'
            ? { clientId: error.message }
            : { contractId: error.message },
        values,
      }
    }
    const message = describeBookingError(error, timeZone)
    if (message) return { error: message, values }
    throw error
  }

  // Écrite dans l'agenda Google de la ressource, après la réponse (ADR 014).
  after(() => syncBookingToGoogleCalendar(createdId))
  // Réservée pour une entreprise : elle en est prévenue (ADR 038).
  if (isUuid(values.clientId)) after(() => notifyBookingConfirmed(createdId))
  const day = toIsoDate(startsAt, timeZone)
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
  redirect(`/reservations?date=${day}`)
}

/**
 * Déplacement d'une réservation existante.
 *
 * Même contrôle d'accès et même traduction des erreurs que la création : une
 * action serveur s'invoque par son identifiant depuis n'importe quel chemin
 * (ADR 008).
 */
export async function moveBookingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('reservations.gerer')
  const timeZone = await currentTimeZone()
  const id = text(formData, 'id')
  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')

  if (!id) return { error: 'Réservation inconnue.' }
  if (!resourceId) return { error: 'Choisir une ressource.' }

  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = wallClockToUtc(`${date}T${text(formData, 'startTime')}`, timeZone)
    // Jour de fin d'une période sur plusieurs jours (ADR 061) ; absent, le jour même.
    endsAt = wallClockToUtc(`${text(formData, 'endDate') || date}T${text(formData, 'endTime')}`, timeZone)
  } catch {
    return { error: 'Date ou horaires illisibles.' }
  }

  // Lue avant le déplacement : changée de salle, la réservation doit quitter
  // l'agenda Google de l'ancienne (ADR 014).
  const previousResourceId = (await findBooking(id))?.resourceId
  try {
    await moveBooking({ id, resourceId, startsAt, endsAt })
  } catch (error) {
    const message = describeBookingError(error, timeZone)
    if (message) return { error: message }
    throw error
  }

  after(() => syncBookingToGoogleCalendar(id, previousResourceId))
  // Le matériel en option a suivi la salle (ADR 062) : ses agendas aussi.
  const moved = (await listOptionsOf([id])).filter((option) => option.status !== 'cancelled')
  if (moved.length > 0) after(() => syncBookingsToGoogleCalendar(moved.map((option) => option.id)))
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
  revalidatePath(`/reservations/${id}`)
  redirect(`/reservations/${id}`)
}

export async function cancelBookingAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('reservations.gerer')
  const id = text(formData, 'id')
  if (!id) return
  // Lue avant : seule une réservation encore active d'une entreprise donne un
  // message d'annulation (ADR 038).
  const before = isUuid(id) ? await findBooking(id) : undefined
  // L'auteur est tracé (ADR 036) : l'espace client dit « annulée par le centre ».
  // Le matériel en option est annulé avec la salle (ADR 062).
  const { cancelledOptionIds } = await cancelBooking(id, text(formData, 'reason') || null, member.id)
  // Retire l'événement de l'agenda Google de la ressource, pour qu'il ne montre
  // pas un créneau libéré comme occupé (ADR 014).
  after(() => syncBookingToGoogleCalendar(id))
  if (cancelledOptionIds.length > 0) after(() => syncBookingsToGoogleCalendar(cancelledOptionIds))
  // Un appareil annulé seul quitte le devis de sa salle (ADR 062).
  if (before?.parentBookingId && before.status !== 'cancelled') {
    await syncOptionLinesAfterCancel(id, member.id, await currentTimeZone())
    revalidatePath('/devis', 'layout')
  }
  if (before && before.status !== 'cancelled' && before.clientId) after(() => notifyBookingCancelled(id))
  revalidatePath('/')
  // Portée `layout` : le planning et la fiche de la réservation doivent tous
  // deux repartir de la base, pas du cache de rendu.
  revalidatePath('/reservations', 'layout')
}

/**
 * Validation d'une demande publique (ADR 005). Le créneau était bloqué depuis
 * le dépôt : confirmer ne peut pas échouer sur un conflit.
 *
 * L'écriture dans Google Agenda part après la réponse (ADR 014) : la
 * validation est acquise en base, que Google réponde ou non.
 */
export async function confirmBookingAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('demandes.traiter')
  const id = text(formData, 'id')
  if (!id) return
  const before = isUuid(id) ? await findBooking(id) : undefined
  // Le matériel en option qui l'attendait est validé avec elle (ADR 062).
  const { confirmedOptionIds } = await confirmBooking(id, member.id)
  after(() => syncBookingToGoogleCalendar(id))
  if (confirmedOptionIds.length > 0) after(() => syncBookingsToGoogleCalendar(confirmedOptionIds))
  // Le client d'une demande validée en est prévenu (ADR 038).
  if (before?.status === 'pending') after(() => notifyBookingRequestAccepted(id))
  revalidatePath('/demandes')
  revalidatePath('/reservations', 'layout')
}

/** Refus d'une demande : annulation motivée, le créneau redevient libre. */
export async function refuseBookingAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('demandes.traiter')
  const id = text(formData, 'id')
  if (!id) return
  const before = isUuid(id) ? await findBooking(id) : undefined
  // Le matériel demandé avec elle est refusé aussi (ADR 062).
  const { cancelledOptionIds } = await refuseBooking(id, text(formData, 'reason') || null, member.id)
  if (cancelledOptionIds.length > 0) after(() => syncBookingsToGoogleCalendar(cancelledOptionIds))
  // Un appareil refusé seul, sur une salle déjà validée, quitte son devis.
  if (before?.parentBookingId && before.status === 'pending') {
    await syncOptionLinesAfterCancel(id, member.id, await currentTimeZone())
    revalidatePath('/devis', 'layout')
  }
  if (before?.status === 'pending') after(() => notifyBookingRequestRefused(id))
  revalidatePath('/')
  revalidatePath('/demandes')
  revalidatePath('/reservations', 'layout')
}

export type AssignClientFormState = { error?: string; saved?: boolean } | null

/**
 * Rattache une réservation à un client, ou l'en détache (ADR 015) : c'est ce
 * qui la fait apparaître dans son espace. Utile pour une demande déposée par
 * une personne qui gère plusieurs entreprises, et pour l'historique d'avant
 * l'espace client. Rend un état : enregistré, ou la raison du refus (client
 * figé par l'espace client, un état des lieux ou une facture, ADR 041).
 */
export async function assignBookingClientAction(
  _previous: AssignClientFormState,
  formData: FormData,
): Promise<AssignClientFormState> {
  await requirePermission('reservations.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Réservation introuvable.' }
  const clientId = text(formData, 'clientId')
  const outcome = await assignBookingClient(id, isUuid(clientId) ? clientId : null)
  if (!outcome.ok) return { error: outcome.message }
  revalidatePath(`/reservations/${id}`)
  revalidatePath('/compte/reservations')
  return { saved: true }
}
