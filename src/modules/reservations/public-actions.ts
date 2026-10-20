'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { withTenant } from '../../db/index.ts'
import { formatLongDate, formatTime, toIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { clientAccess } from '../clients/session.ts'
import { quote } from '../facturation/devis-queries.ts'
import { toQuoteDisplay, type QuoteDisplay } from '../facturation/devis.ts'
import { createProposalInTransaction } from '../facturation/propositions-queries.ts'
import type { ProposalProduct, ProposalStatus } from '../facturation/schema-devis.ts'
import { notifyBookingRequestSubmitted } from '../notifications/declencheurs-reservations.ts'
import { findResource } from '../ressources/queries.ts'
import {
  BookingConflictError,
  InvalidRangeError,
  countRecentRequestsByEmail,
  createBookingRequest,
  listDayAvailability,
} from './queries.ts'
import { errorsByField } from './questionnaire-fields.tsx'
import { parseAnswers, productForResourceType } from './questionnaires.ts'
import {
  MAX_REQUESTS_PER_EMAIL,
  RATE_WINDOW_HOURS,
  contactRejections,
  rejectRequest,
  rejectionMessages,
} from './requests.ts'
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

/** Montant annoncé au visiteur avant sa demande (R11). */
export type PublicQuote =
  | { status: 'priced'; quote: QuoteDisplay; fromContract: boolean }
  | { status: 'unpriced'; message: string }

/**
 * Devis d'un créneau, pour la page publique : le même moteur (`quote()`) que
 * le back-office et que l'écriture de la demande, qui le figera. Un visiteur
 * connecté qui ne représente qu'une entreprise voit le prix de la grille de
 * son contrat ; l'entreprise vient de la session, jamais de la requête.
 *
 * Ne rend que ce qui s'affiche : aucun identifiant de grille ni de contrat.
 */
export async function loadPublicQuoteAction(
  resourceId: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<PublicQuote> {
  const unpriced = (message: string): PublicQuote => ({ status: 'unpriced', message })
  if (!UUID.test(resourceId)) return unpriced(rejectionMessages['ressource-indisponible'])
  const tenant = await currentTenant()
  const selection = publicSelection(date, startTime, endTime, tenant.timezone)
  if (!selection) return unpriced(rejectionMessages['creneau-illisible'])
  const resource = await findResource(resourceId)
  if (!resource || resource.status !== 'active' || resource.deletedAt) {
    return unpriced(rejectionMessages['ressource-indisponible'])
  }
  const result = await quote({ resourceId, ...selection, clientId: await requesterClientId() })
  if (!result.ok) return unpriced('Notre équipe vous précisera le tarif de ce créneau.')
  return {
    status: 'priced',
    quote: toQuoteDisplay(result.quote),
    fromContract: result.quote.source.kind === 'contract',
  }
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
  | {
      status: 'error'
      message: string
      /** Étape à corriger (salle ou véhicule : 1 à 5 ; domiciliation : 1 à 3). */
      step?: 1 | 2 | 3 | 4 | 5
      /** Erreurs par nom de champ (`q.participants`, `email`…), en ligne et dans le résumé. */
      fieldErrors?: Record<string, string>
    }
  | {
      status: 'sent'
      summary: string
      /** Devis né avec la demande (ADR 043) : `ready` part seul, `draft` passe par l'accueil. */
      proposal?: { number: string; status: ProposalStatus }
    }

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** Société et précisions saisies librement : bornées comme les autres champs. */
const COMPANY_MAX_LENGTH = 200
const NOTES_MAX_LENGTH = 2000

const answersToCorrect = 'Certaines réponses sont à corriger.'

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
    return { status: 'error', step: 5, message: 'Le paiement en ligne n’est pas encore disponible. Choisissez « Recevoir un devis ».' }
  }
  const tenant = await currentTenant()
  const timeZone = tenant.timezone

  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')
  const email = text(formData, 'email')
  const company = text(formData, 'company')
  const notes = text(formData, 'notes')
  const product = text(formData, 'product') as ProposalProduct

  if (product !== 'espace' && product !== 'vehicule') {
    return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  }
  if (!UUID.test(resourceId)) return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  const selection = publicSelection(date, text(formData, 'startTime'), text(formData, 'endTime'), timeZone)
  if (!selection) return { status: 'error', step: 2, message: rejectionMessages['creneau-illisible'] }
  const { startsAt, endsAt } = selection

  // La ressource est relue en base : l'identifiant vient d'un `<select>` que
  // n'importe qui peut réécrire avant l'envoi. Son produit aussi : on ne pose
  // pas les questions d'une salle sur un camion.
  const resource = await findResource(resourceId)
  if (!resource || productForResourceType(resource.resourceType) !== product) {
    return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  }
  const bookable = resource.status === 'active' && !resource.deletedAt

  // Relu par le serveur, comme la ressource : le formulaire peut mentir.
  const { answers, errors } = parseAnswers(product, formData)
  if (Object.keys(errors).length > 0) {
    return { status: 'error', step: 3, message: answersToCorrect, fieldErrors: errorsByField(errors) }
  }
  if (company.length > COMPANY_MAX_LENGTH) {
    return { status: 'error', step: 4, message: `Le nom de la société compte ${COMPANY_MAX_LENGTH} caractères au plus.` }
  }
  if (notes.length > NOTES_MAX_LENGTH) {
    return { status: 'error', step: 4, message: `Vos précisions comptent ${NOTES_MAX_LENGTH.toLocaleString('fr-FR')} caractères au plus.` }
  }

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
    const step = contactError ? 4 : rejection === 'ressource-indisponible' ? 1 : 2
    return { status: 'error', step, message: rejection === 'preavis-insuffisant' || rejection === 'creneau-trop-lointain' ? requestPolicyMessage(tenant) : rejectionMessages[rejection] }
  }

  const availability = await loadPublicDayAction(resourceId, date)
  if (availability.status === 'error') return { ...availability, step: 2 }
  if (!fitsFreeRange(selection, availability.free)) {
    return { status: 'error', step: 2, message: 'Ce créneau n’est plus disponible. Choisissez de nouveaux horaires.' }
  }

  let requestId: string
  let proposal: { number: string; status: ProposalStatus } | undefined
  try {
    const created = await createBookingRequest({
      resourceId,
      startsAt,
      endsAt,
      title: text(formData, 'title'),
      notes: ['Demande de devis à envoyer par courriel.', notes].filter(Boolean).join('\n\n'),
      requesterName: text(formData, 'name'),
      requesterEmail: email,
      requesterPhone: text(formData, 'phone'),
      clientId: await requesterClientId(),
      // Le devis naît avec la demande, dans la même transaction (ADR 043).
      proposal: { product, answers, message: notes, requesterCompany: company, timeZone },
    })
    requestId = created.id
    proposal = created.proposal && { number: created.proposal.number, status: created.proposal.status }
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

  // L'accueil est prévenu à l'adresse du centre, après la réponse (ADR 038).
  after(() => notifyBookingRequestSubmitted(requestId))
  // Le planning du staff doit montrer la demande sans attendre.
  revalidatePath('/reservations')
  revalidatePath('/demandes')
  revalidatePath('/devis')
  revalidatePath('/')

  const jour = formatLongDate(toIsoDate(startsAt, timeZone), timeZone)
  return {
    status: 'sent',
    summary: `${resource.name} — ${jour} de ${formatTime(startsAt, timeZone)} à ${formatTime(endsAt, timeZone)}`,
    proposal,
  }
}

/**
 * Demande de devis de domiciliation depuis la page publique (ADR 043) : pas de
 * créneau, donc pas de réservation, seulement un devis brouillon que l'accueil
 * relit (vérifications légales du domiciliataire).
 *
 * Mêmes garde-fous que la demande de salle : coordonnées exigées, quota par
 * adresse. Le quota ne compte que les demandes de réservation (`bookings`) :
 * des devis de domiciliation en rafale n'y entrent pas.
 */
export async function requestDomiciliationAction(
  _previous: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  const tenant = await currentTenant()
  const { answers, errors } = parseAnswers('domiciliation', formData, { today: todayIsoDate(tenant.timezone) })
  if (Object.keys(errors).length > 0) {
    return { status: 'error', step: 1, message: answersToCorrect, fieldErrors: errorsByField(errors) }
  }

  const contact = { name: text(formData, 'name'), email: text(formData, 'email'), phone: text(formData, 'phone') }
  const rejections = contactRejections(contact)
  if (Object.keys(rejections).length > 0) {
    return {
      status: 'error',
      step: 2,
      message: 'Vos coordonnées sont à compléter.',
      fieldErrors: Object.fromEntries(
        Object.entries(rejections).map(([field, rejection]) => [field, rejectionMessages[rejection]]),
      ),
    }
  }
  const message = text(formData, 'notes')
  if (message.length > NOTES_MAX_LENGTH) {
    return { status: 'error', step: 2, message: `Vos précisions comptent ${NOTES_MAX_LENGTH.toLocaleString('fr-FR')} caractères au plus.` }
  }
  if ((await countRecentRequestsByEmail(contact.email, RATE_WINDOW_HOURS)) >= MAX_REQUESTS_PER_EMAIL) {
    return { status: 'error', step: 3, message: rejectionMessages['trop-de-demandes'] }
  }

  const clientId = await requesterClientId()
  const raisonSociale = String(answers.raisonSociale ?? '')
  const proposal = await withTenant(currentTenantId(), (tx) =>
    createProposalInTransaction(tx, {
      product: 'domiciliation',
      // Rattachée à son entreprise, la demande vient d'une personne connectée
      // à son espace (ADR 015) ; sinon d'un visiteur (ADR 005).
      channel: clientId ? 'client' : 'public',
      clientId,
      requesterName: contact.name,
      requesterEmail: contact.email,
      requesterPhone: contact.phone,
      requesterCompany: raisonSociale,
      answers,
      message,
      lines: [],
    }),
  )

  // Pas encore d'avis à l'accueil pour une domiciliation : la liste des devis la montre.
  revalidatePath('/devis')

  return {
    status: 'sent',
    summary: `Domiciliation de ${raisonSociale}`,
    proposal: { number: proposal.number, status: proposal.status },
  }
}
