'use server'

import { revalidatePath } from 'next/cache'

import { formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { clientAccess } from '../clients/session.ts'
import { findResource } from '../ressources/queries.ts'
import {
  BookingConflictError,
  InvalidRangeError,
  countRecentRequestsByEmail,
  createBookingRequest,
  listDayAvailability,
} from './queries.ts'
import { RATE_WINDOW_HOURS, rejectRequest, rejectionMessages } from './requests.ts'
import { requestableRanges, requestBounds, requestPolicyMessage } from './request-policy.ts'
import { fitsFreeRange, publicSelection } from './public-selection.ts'
import type { TimeRange } from './availability.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PublicDayAvailability =
  | { status: 'ready'; free: TimeRange[]; closed: boolean; latestStart: Date }
  | { status: 'error'; message: string }

/** Ne renvoie que les plages libres, jamais l'identité des occupants. */
export async function loadPublicDayAction(resourceId: string, date: string): Promise<PublicDayAvailability> {
  if (!UUID.test(resourceId)) return { status: 'error', message: rejectionMessages['ressource-indisponible'] }
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const now = new Date()
  const { earliest, latest } = requestBounds(tenant, now)
  if (!publicSelection(date, '09:00', '10:00', timeZone) || date < toIsoDate(earliest, timeZone) || date > toIsoDate(latest, timeZone)) {
    return { status: 'error', message: requestPolicyMessage(tenant) }
  }
  const availability = (await listDayAvailability(date, timeZone)).find(({ resource }) => resource.id === resourceId)
  if (!availability) return { status: 'error', message: rejectionMessages['ressource-indisponible'] }
  return { status: 'ready', free: requestableRanges(availability.free, tenant, now), closed: availability.closed, latestStart: latest }
}

/**
 * Dépôt d'une demande depuis la page publique (ADR 005).
 *
 * Seul point d'écriture ouvert à tous : rien de ce qui arrive ici n'a été
 * filtré en amont, et le message renvoyé ne doit jamais révéler autre chose que
 * ce que le visiteur peut déjà voir sur la page.
 */
export type PublicFormState =
  | { status: 'idle' }
  | { status: 'error'; message: string; step?: 1 | 2 | 3 | 4 }
  | { status: 'sent'; summary: string }

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/**
 * Entreprise du visiteur connecté à son espace client (ADR 015) : sa demande y
 * apparaîtra. Seulement quand il n'en représente qu'une — pour une personne qui
 * gère plusieurs sociétés, deviner laquelle réserve serait attribuer la
 * facture au hasard ; le centre la rattache à la validation.
 */
async function requesterClientId(): Promise<string | null> {
  const access = await clientAccess()
  return access.status === 'client' && access.accounts.length === 1
    ? access.accounts[0].clientId
    : null
}

export async function requestBookingAction(
  _previous: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  // Aucun débit ni réservation ne doit être simulé avant le raccordement CB.
  if (text(formData, 'paymentMethod') !== 'quote') {
    return { status: 'error', step: 4, message: 'Le paiement en ligne n’est pas encore disponible. Choisissez « Recevoir un devis ».' }
  }
  const tenant = await currentTenant()
  const timeZone = tenant.timezone

  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')
  const email = text(formData, 'email')

  if (!UUID.test(resourceId)) return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  const selection = publicSelection(date, text(formData, 'startTime'), text(formData, 'endTime'), timeZone)
  if (!selection) return { status: 'error', step: 2, message: rejectionMessages['creneau-illisible'] }
  const { startsAt, endsAt } = selection

  // La ressource est relue en base : l'identifiant vient d'un `<select>` que
  // n'importe qui peut réécrire avant l'envoi.
  const resource = resourceId ? await findResource(resourceId) : undefined
  const bookable = Boolean(resource && resource.status === 'active' && !resource.deletedAt)

  // Le quota n'est interrogé que si l'adresse est exploitable, pour ne pas
  // lancer une requête par soumission vide.
  const recentRequestCount =
    bookable && email ? await countRecentRequestsByEmail(email, RATE_WINDOW_HOURS) : 0

  const rejection = rejectRequest({
    name: text(formData, 'name'),
    email,
    phone: text(formData, 'phone'),
    title: text(formData, 'title'),
    range: { startsAt, endsAt },
    resourceIsBookable: bookable,
    recentRequestCount,
  }, new Date(), tenant)
  if (rejection) {
    const contactError = ['nom-manquant', 'email-invalide', 'telephone-manquant', 'objet-manquant'].includes(rejection)
    return { status: 'error', step: contactError ? 3 : 2, message: rejection === 'preavis-insuffisant' || rejection === 'creneau-trop-lointain' ? requestPolicyMessage(tenant) : rejectionMessages[rejection] }
  }

  const availability = await loadPublicDayAction(resourceId, date)
  if (availability.status === 'error') return { ...availability, step: 2 }
  if (!fitsFreeRange(selection, availability.free)) {
    return { status: 'error', step: 2, message: 'Ce créneau n’est plus disponible. Choisissez de nouveaux horaires.' }
  }

  try {
    await createBookingRequest({
      resourceId,
      startsAt,
      endsAt,
      title: text(formData, 'title'),
      notes: ['Demande de devis à envoyer par courriel.', text(formData, 'notes')].filter(Boolean).join('\n\n'),
      requesterName: text(formData, 'name'),
      requesterEmail: email,
      requesterPhone: text(formData, 'phone'),
      clientId: await requesterClientId(),
    })
  } catch (error) {
    if (error instanceof InvalidRangeError) {
      return { status: 'error', message: rejectionMessages['duree-trop-courte'] }
    }
    if (error instanceof BookingConflictError) {
      // Le détail des réservations en conflit reste au staff : un visiteur n'a
      // pas à savoir qui occupe la salle. La page affiche déjà les créneaux
      // libres, il suffit de l'y renvoyer.
      return {
        status: 'error',
        step: 2,
        message: 'Ce créneau vient d’être pris. Choisissez-en un autre parmi les créneaux libres.',
      }
    }
    throw error
  }

  // Le planning du staff doit montrer la demande sans attendre.
  revalidatePath('/reservations')
  revalidatePath('/demandes')
  revalidatePath('/')

  const jour = formatLongDate(toIsoDate(startsAt, timeZone), timeZone)
  return {
    status: 'sent',
    summary: `${resource?.name} — ${jour} de ${formatTime(startsAt, timeZone)} à ${formatTime(endsAt, timeZone)}`,
  }
}
