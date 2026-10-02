'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
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
  updateForwardShipping,
} from './demandes-queries.ts'
import {
  readPostage,
  readRefusalReason,
  readRequestFilters,
  readTrackingNumber,
  requestFiltersQuery,
} from './demandes-regles.ts'
import { readScan } from './fichiers.ts'
import { notifyMailScanned } from './notifications.ts'
import { notifyMailForwarded, notifyMailRequestRefused } from './notifications-demandes.ts'

/**
 * Traitement des demandes par l'accueil (R21, ADR 037). Chaque action se
 * protège elle-même (`requirePermission`, ADR 008, ADR 019) : le droit est
 * celui du courrier.
 *
 * Succès : retour au pli, avec une confirmation annoncée (`?fait=`). Échec :
 * l'état rendu au formulaire — un refus de la base (CA008) dit pourquoi.
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

/** Refus métier rendu au formulaire ; une panne remonte. */
function refusal(error: unknown): RequestActionState {
  if (error instanceof MailRequestError) return { error: error.message }
  throw error
}

export async function startMailRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  let result
  try {
    result = await startMailRequest(text(formData, 'id'), member.id)
  } catch (error) {
    return refusal(error)
  }
  done(result.mailItemId, 'prise-en-charge')
}

/**
 * Prise en charge groupée, depuis la file : chaque demande cochée pour son
 * compte — une demande annulée entre-temps par le client est comptée à part,
 * les autres passent. Retour à la file, filtres gardés, avec le bilan.
 */
export async function startMailRequestsAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('courrier.gerer')
  const ids = [...new Set(formData.getAll('ids').map(String))].slice(0, 200)
  let started = 0
  let skipped = 0
  for (const id of ids) {
    try {
      await startMailRequest(id, member.id)
      started += 1
    } catch (error) {
      if (!(error instanceof MailRequestError)) throw error
      skipped += 1
    }
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
  revalidatePath('/courrier', 'layout')
  revalidatePath('/compte/courrier', 'layout')
  redirect(`/courrier/demandes${query}${query ? '&' : '?'}prises=${started}&ignorees=${skipped}`)
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
    return { ...refusal(error), values }
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
    return refusal(error)
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
    return { ...refusal(error), values: read.values }
  }
  after(() => notifyMailForwarded(result.id))
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
    return { ...refusal(error), values: read.values }
  }
  done(result.mailItemId, 'envoi')
}

export async function completeScanRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const { member } = await requirePermission('courrier.gerer')
  const content = await readScan(formData.get('requestContent'))
  if (content.error) return { fieldErrors: { requestContent: content.error } }
  if (!content.scan) return { fieldErrors: { requestContent: 'Joignez la numérisation demandée.' } }

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
  // Même message que l'ouverture : la numérisation est dans l'espace.
  after(() => notifyMailScanned(result.mailItemId))
  done(result.mailItemId, 'numerisee')
}
