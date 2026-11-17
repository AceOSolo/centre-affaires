'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { after } from 'next/server'

import { withTenant } from '../../db/index.ts'
import { creerCompteur, ipDuVisiteur, type Plafond } from '../../lib/anti-robot.ts'
import { CHAMP_PREUVE, champPiegeRempli } from '../../lib/champs-anti-robot.ts'
import { preuveHumaine } from '../../lib/preuve-humaine.ts'
import { toIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { clientAccess } from '../clients/session.ts'
import { sendRequestReceived } from '../comptes/demandes-site.ts'
import { quote } from '../facturation/devis-queries.ts'
import { toQuoteDisplay, type QuoteDisplay } from '../facturation/devis.ts'
import { createProposalInTransaction } from '../facturation/propositions-queries.ts'
import type { ProposalProduct, ProposalStatus } from '../facturation/schema-devis.ts'
import {
  notifyBookingRequestSubmitted,
  notifyDomiciliationRequestSubmitted,
} from '../notifications/declencheurs-reservations.ts'
import { formulasOf, rentalFormulaLabels, type RentalFormula } from '../ressources/formules.ts'
import { findResource } from '../ressources/queries.ts'
import { maxRequestDaysFor } from './durees.ts'
import {
  choiceRejectionMessage,
  choiceSpanDays,
  choiceUnit,
  evaluateChoice,
  formulaLimitsOf,
  parseChosenFormula,
  readChoice,
  type FormulaLimits,
} from './formules-periode.ts'
import { dayFreeRanges, periodLabel, type PeriodAvailability } from './periode.ts'
import { loadPeriodAvailability } from './periode-queries.ts'
import {
  BookingConflictError,
  InvalidRangeError,
  countRecentRequestsByEmail,
  createBookingRequest,
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
import { periodSelection, publicSelection } from './public-selection.ts'
import type { TimeRange } from './availability.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PublicDayAvailability =
  | {
      status: 'ready'
      /** Plages libres du jour choisi, coupées par le préavis : les départs possibles. */
      free: TimeRange[]
      closed: boolean
      latestStart: Date
      /** La ressource sur les jours que peut couvrir une demande, à partir de ce jour (ADR 061). */
      period: PeriodAvailability
      /** Jours d'affilée qu'une demande peut couvrir pour ce produit. */
      maxDays: number
      /** Formules de location réglées sur la ressource (ADR 076) ; vide : le formulaire libre. */
      formulas: RentalFormula[]
      /** Plafonds des locations à la semaine et au mois, durée d'une demi-journée. */
      limits: FormulaLimits
      /** Premier début permis : maintenant et le préavis du centre. */
      earliest: Date
    }
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
  const resource = await findResource(resourceId)
  if (!resource || resource.status !== 'active' || resource.deletedAt) {
    return { status: 'error', message: rejectionMessages['ressource-indisponible'] }
  }
  // La période couvre les jours que la demande peut atteindre — la durée
  // maximale du produit, la plus longue des formules de la ressource : le
  // moteur vérifie la ressource jusqu'au bout (ADR 061, ADR 076).
  const maxDays = maxRequestDaysFor(tenant.bookingMaxDays, resource.resourceType)
  const formulas = formulasOf(resource)
  const limits = formulaLimitsOf(tenant)
  const period = await withTenant(currentTenantId(), (tx) =>
    loadPeriodAvailability(tx, {
      resourceId,
      firstDate: date,
      dayCount: choiceSpanDays(formulas, date, maxDays, limits),
      timeZone,
    }),
  )
  return {
    status: 'ready',
    free: requestableRanges(dayFreeRanges(period, date), tenant, now),
    closed: period.days[0].windows.length === 0,
    latestStart: latest,
    period,
    maxDays,
    formulas,
    limits,
    earliest,
  }
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
  /** Jour de fin, pour une demande sur plusieurs jours (ADR 061) ; le jour même par défaut. */
  endDate: string = date,
  /** Formule de location choisie (ADR 076) : son unité fait le prix. */
  formula: string = '',
): Promise<PublicQuote> {
  const unpriced = (message: string): PublicQuote => ({ status: 'unpriced', message })
  if (!UUID.test(resourceId)) return unpriced(rejectionMessages['ressource-indisponible'])
  const tenant = await currentTenant()
  const selection = periodSelection(date, startTime, endDate, endTime, tenant.timezone)
  if (!selection) return unpriced(rejectionMessages['creneau-illisible'])
  const resource = await findResource(resourceId)
  if (!resource || resource.status !== 'active' || resource.deletedAt) {
    return unpriced(rejectionMessages['ressource-indisponible'])
  }
  const chosen = parseChosenFormula(formula, formulasOf(resource))
  if (!chosen) return unpriced('Choisissez une formule proposée pour cet espace.')
  const result = await quote({ resourceId, ...selection, clientId: await requesterClientId(), unit: choiceUnit(chosen) })
  // Sans prix à l'unité de la formule, rien n'est inventé (ADR 076).
  if (!result.ok) return unpriced('Tarif communiqué par l’accueil : notre équipe vous le précisera avec votre devis.')
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
 * Plafonds des demandes déposées sans compte (`lib/anti-robot.ts`), salles,
 * véhicule et domiciliation confondus : par adresse IP, et pour tout le site
 * contre des robots répartis sur beaucoup d'adresses. Au-delà, le visiteur
 * est renvoyé vers l'accueil, qui reste joignable.
 */
const PAR_ADRESSE_IP: Plafond = { fenetreSecondes: 3600, max: 5 }
const POUR_TOUT_LE_SITE: Plafond = { fenetreSecondes: 3600, max: 30 }
const compteur = creerCompteur()

const refusRobot = 'Votre demande n’a pas pu être envoyée. Contactez-nous directement.'

/**
 * Dernier contrôle avant l'écriture, après la validation : une personne qui
 * corrige ses réponses n'use ni sa preuve ALTCHA (`lib/preuve-humaine.ts`),
 * qui ne sert qu'une fois, ni son plafond. Rend le message du refus, ou null.
 */
async function refusAntiRobot(formData: FormData): Promise<string | null> {
  if (!(await preuveHumaine().verifier(formData.get(CHAMP_PREUVE)))) {
    return 'La vérification anti-robot n’a pas abouti ou a expiré. Attendez que la case « Je ne suis pas un robot » se coche, puis renvoyez.'
  }
  const ip = ipDuVisiteur(await headers()) ?? 'inconnue'
  const depasse = compteur.passer([
    [`demande|${ip}`, PAR_ADRESSE_IP],
    ['demande', POUR_TOUT_LE_SITE],
  ])
  if (!depasse) return null
  return depasse === 'demande'
    ? 'Notre service de demande en ligne reçoit beaucoup de demandes. Réessayez dans un moment ou contactez-nous directement.'
    : 'Plusieurs demandes sont déjà parties de votre connexion dans l’heure. Réessayez plus tard ou contactez-nous directement.'
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
  if (champPiegeRempli(formData)) return { status: 'error', message: refusRobot }
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

  // Les produits sur créneau ; la domiciliation a son propre formulaire.
  if (product !== 'espace' && product !== 'vehicule' && product !== 'materiel') {
    return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  }
  if (!UUID.test(resourceId)) return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }

  // La ressource est relue en base : l'identifiant vient d'un `<select>` que
  // n'importe qui peut réécrire avant l'envoi. Son produit aussi : on ne pose
  // pas les questions d'une salle sur un camion.
  const resource = await findResource(resourceId)
  if (!resource || productForResourceType(resource.resourceType) !== product) {
    return { status: 'error', step: 1, message: rejectionMessages['ressource-indisponible'] }
  }
  const bookable = resource.status === 'active' && !resource.deletedAt

  // La formule et la période, relues sur des disponibilités fraîches, sur
  // toute l'étendue : le formulaire a pu rester ouvert, ou mentir (ADR 061,
  // ADR 076). Le trigger anti-chevauchement reste le garde final (décision 3).
  const formulas = formulasOf(resource)
  const formula = parseChosenFormula(formData.get('formula'), formulas)
  const availability = await loadPublicDayAction(resourceId, date)
  if (availability.status === 'error') return { ...availability, step: 2 }
  if (!formula) {
    return { status: 'error', step: 2, message: choiceRejectionMessage('formule-indisponible', availability.maxDays, availability.limits) }
  }
  const evaluation = evaluateChoice(
    readChoice(formData, formula, date),
    {
      date,
      timeZone,
      availability: availability.period,
      earliest: availability.earliest,
      maxDays: availability.maxDays,
      limits: availability.limits,
    },
    formulas,
  )
  if (!evaluation.range) {
    return { status: 'error', step: 2, message: choiceRejectionMessage(evaluation.rejection, availability.maxDays, availability.limits) }
  }
  const { startsAt, endsAt } = evaluation.range

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

  if (evaluation.rejection) {
    return { status: 'error', step: 2, message: choiceRejectionMessage(evaluation.rejection, availability.maxDays, availability.limits) }
  }
  const refus = await refusAntiRobot(formData)
  if (refus) return { status: 'error', message: refus }

  let requestId: string
  let proposal: { number: string; status: ProposalStatus } | undefined
  const clientId = await requesterClientId()
  try {
    const created = await createBookingRequest({
      resourceId,
      startsAt,
      endsAt,
      title: text(formData, 'title'),
      notes: [
        'Demande de devis à envoyer par courriel.',
        formula !== 'libre' ? `Formule : ${rentalFormulaLabels[formula].toLocaleLowerCase('fr-FR')}.` : '',
        notes,
      ]
        .filter(Boolean)
        .join('\n\n'),
      requesterName: text(formData, 'name'),
      requesterEmail: email,
      requesterPhone: text(formData, 'phone'),
      clientId,
      // Le prix suit l'unité de la formule choisie (ADR 076).
      pricing: { mode: 'grid', unit: choiceUnit(formula) },
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
  // Le visiteur reçoit l'accusé de réception, avec le lien pour créer son
  // espace et y suivre sa demande (ADR 068). Connecté, il la voit déjà.
  if (!clientId) after(() => sendRequestReceived({ bookingId: requestId }))
  // Le planning du staff doit montrer la demande sans attendre.
  revalidatePath('/reservations')
  revalidatePath('/demandes')
  revalidatePath('/devis')
  revalidatePath('/')

  return {
    status: 'sent',
    summary: `${resource.name} — ${periodLabel({ startsAt, endsAt }, timeZone)}`,
    proposal,
  }
}

/**
 * Demande de devis de domiciliation depuis la page publique (ADR 043) : pas de
 * créneau, donc pas de réservation, seulement un devis brouillon que l'accueil
 * relit (vérifications légales du domiciliataire).
 *
 * Mêmes garde-fous que la demande de salle : coordonnées exigées, quota par
 * adresse. Le quota par adresse électronique ne compte que les demandes de
 * réservation (`bookings`) ; les plafonds par adresse IP et du site comptent
 * aussi les devis de domiciliation.
 */
export async function requestDomiciliationAction(
  _previous: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  if (champPiegeRempli(formData)) return { status: 'error', message: refusRobot }
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
  const refus = await refusAntiRobot(formData)
  if (refus) return { status: 'error', message: refus }

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

  // L'accueil est prévenu à l'adresse du centre, après la réponse (ADR 038).
  after(() => notifyDomiciliationRequestSubmitted(proposal.id))
  // Le visiteur reçoit l'accusé de réception et le lien de son espace (ADR 068).
  if (!clientId) after(() => sendRequestReceived({ proposalId: proposal.id }))
  revalidatePath('/devis')

  return {
    status: 'sent',
    summary: `Domiciliation de ${raisonSociale}`,
    proposal: { number: proposal.number, status: proposal.status },
  }
}
