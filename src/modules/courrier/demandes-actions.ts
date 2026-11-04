'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  MailRequestError,
  cancelMailRequestForClient,
  completeForwardRequest,
  completeScanRequest,
  refuseMailRequest,
  startMailRequest,
  startMailRequests,
  updateForwardShipping,
} from './demandes-queries.ts'
import {
  readPostage,
  readRefusalReason,
  readRequestFilters,
  readTrackingNumber,
  requestFiltersQuery,
} from './demandes-regles.ts'
import { readScans } from './fichiers.ts'
import { withPageCount } from './pages.ts'
import { notifyMailRequestDone, notifyMailRequestRefused } from './notifications.ts'

/**
 * Traitement des demandes par l'accueil (R21, ADR 037). Chaque action se
 * protège elle-même (`requirePermission`, ADR 008, ADR 019) : le droit est
 * celui du courrier.
 *
 * Succès : retour au pli, avec une confirmation annoncée (`?fait=`). Échec :
 * l'état rendu au formulaire — un refus de la base (CA008) dit pourquoi. Une
 * erreur imprévue est journalisée pour l'exploitation et dite en français,
 * jamais en page d'erreur du serveur (ADR 057).
 */
export type RequestActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

function done(mailItemId: string, notice: string): never {
  revalidatePath('/courrier', 'layout')
  revalidatePath('/compte/courrier', 'layout')
  redirect(`/courrier/${mailItemId}?fait=${notice}`)
}

const UNEXPECTED =
  'Le serveur n’a pas pu enregistrer cette étape : rien n’a été modifié. Réessayez ; si cela se reproduit, prévenez la personne qui administre l’application.'

/**
 * Refus métier rendu au formulaire. Une erreur imprévue — de la base ou
 * d'ailleurs — est journalisée avec son contexte (`docker compose logs app`)
 * et dite à l'écran : la transaction l'a annulée, rien n'est écrit.
 */
function refusal(error: unknown, context: string): RequestActionState {
  // Une redirection de Next (session expirée, droit manquant) n'est pas une erreur.
  unstable_rethrow(error)
  if (error instanceof MailRequestError) return { error: error.message }
  console.error(`${context} : erreur imprévue`, error)
  return { error: UNEXPECTED }
}

export async function startMailRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  const id = text(formData, 'id')
  let result
  try {
    result = await startMailRequest(id, member.id)
  } catch (error) {
    return refusal(error, `Prise en charge de la demande de courrier ${id}`)
  }
  done(result.mailItemId, 'prise-en-charge')
}

/** Files d'où part une prise en charge groupée, et où elle revient. */
const groupReturns = ['/courrier/demandes', '/demandes'] as const

/**
 * Prise en charge groupée, depuis la file du courrier ou depuis « Demandes »
 * (ADR 048, ADR 057) : chaque demande cochée pour son compte — une demande
 * annulée entre-temps par le client est comptée à part, une panne sur l'une
 * n'arrête pas les autres. Retour à la file d'origine, filtres gardés, avec
 * le bilan.
 */
export async function startMailRequestsAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('courrier.gerer')
  const ids = [...new Set(formData.getAll('ids').map(String))].slice(0, 200)
  const { started, skipped, failed } = await startMailRequests(ids, member.id)
  const outcome = `prises=${started}&ignorees=${skipped}${failed > 0 ? `&echecs=${failed}` : ''}`
  revalidatePath('/courrier', 'layout')
  revalidatePath('/compte/courrier', 'layout')
  revalidatePath('/demandes')

  const back = groupReturns.find((path) => path === text(formData, 'retour')) ?? '/courrier/demandes'
  if (back === '/demandes') {
    const product = text(formData, 'produit') === 'domiciliation' ? 'produit=domiciliation&' : ''
    redirect(`/demandes?${product}${outcome}#courrier`)
  }
  const filters = readRequestFilters({
    etat: text(formData, 'etat'),
    nature: text(formData, 'nature'),
    page: text(formData, 'page'),
  })
  const client = text(formData, 'client')
  const query = requestFiltersQuery(
    { state: filters.state, kindSlug: filters.kindSlug, clientId: isUuid(client) ? client : undefined },
    filters.page,
  )
  redirect(`/courrier/demandes${query}${query ? '&' : '?'}${outcome}`)
}

export async function refuseMailRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  const values = { refusalReason: text(formData, 'refusalReason') }
  const reason = readRefusalReason(values.refusalReason)
  if (reason.error !== undefined) return { fieldErrors: { refusalReason: reason.error }, values }

  let result
  try {
    result = await refuseMailRequest(text(formData, 'id'), member.id, reason.value)
  } catch (error) {
    return { ...refusal(error, `Refus de la demande de courrier ${text(formData, 'id')}`), values }
  }
  after(() => notifyMailRequestRefused(result.id))
  done(result.mailItemId, 'refus')
}

export async function cancelMailRequestForClientAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  let result
  try {
    result = await cancelMailRequestForClient(text(formData, 'id'), member.id)
  } catch (error) {
    return refusal(error, `Annulation de la demande de courrier ${text(formData, 'id')}`)
  }
  done(result.mailItemId, 'annulation')
}

/** Suivi et frais saisis : lus et vérifiés ensemble, pour un résumé d'erreurs complet. */
function readShipping(formData: FormData) {
  const values = {
    trackingNumber: text(formData, 'trackingNumber'),
    postage: text(formData, 'postage'),
  }
  const fieldErrors: Record<string, string> = {}
  const tracking = readTrackingNumber(values.trackingNumber)
  if (tracking.error !== undefined) fieldErrors.trackingNumber = tracking.error
  const postage = readPostage(values.postage)
  if (postage.error !== undefined) fieldErrors.postage = postage.error
  if (tracking.error !== undefined || postage.error !== undefined) return { values, fieldErrors }
  return { values, shipping: { trackingNumber: tracking.value, postageCents: postage.cents } }
}

export async function completeForwardRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  const read = readShipping(formData)
  if (!read.shipping) return { fieldErrors: read.fieldErrors, values: read.values }

  let result
  try {
    result = await completeForwardRequest(text(formData, 'id'), member.id, read.shipping)
  } catch (error) {
    return { ...refusal(error, `Réexpédition de la demande de courrier ${text(formData, 'id')}`), values: read.values }
  }
  after(() => notifyMailRequestDone(result.id))
  done(result.mailItemId, 'reexpediee')
}

export async function updateForwardShippingAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  await requirePermission('courrier.gerer')
  const read = readShipping(formData)
  if (!read.shipping) return { fieldErrors: read.fieldErrors, values: read.values }

  let result
  try {
    result = await updateForwardShipping(text(formData, 'id'), read.shipping)
  } catch (error) {
    return { ...refusal(error, `Suivi de la réexpédition ${text(formData, 'id')}`), values: read.values }
  }
  done(result.mailItemId, 'envoi')
}

export async function completeScanRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  // Plusieurs photos des pages demandées font un seul PDF (ADR 055).
  const read = await readScans(formData.getAll('requestContent'))
  if (read.error) return { fieldErrors: { requestContent: read.error } }
  if (!read.scan) return { fieldErrors: { requestContent: 'Joignez la numérisation demandée.' } }
  // Pages comptées comme à l'ouverture (ADR 044) ; la numérisation demandée,
  // elle, se facture par sa demande.
  const content = withPageCount(formData, 'requestContent', read.scan)
  if (content.error || !content.scan) {
    return { fieldErrors: { requestContentPages: content.error ?? '' } }
  }

  let result
  try {
    result = await completeScanRequest(text(formData, 'id'), member.id, content.scan)
  } catch (error) {
    if (error instanceof MailRequestError) return { error: error.message }
    console.error('Dépôt de numérisation impossible', error)
    // Jamais de dépôt en clair faute de clé (ADR 020) : le dire.
    return {
      error:
        error instanceof DocumentKeyError
          ? 'Le fichier n’a pas été déposé : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.'
          : 'Le fichier n’a pas pu être déposé. Réessayez ; si le problème persiste, le stockage est peut-être indisponible.',
    }
  }
  // « Demande traitée » (ADR 038) : la numérisation est dans l'espace.
  after(() => notifyMailRequestDone(result.id))
  done(result.mailItemId, 'numerisee')
}
