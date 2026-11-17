'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { isUuid } from '../../lib/uuid.ts'
import { depositContent, discardContentDraft, validateContentDraft } from './depots.ts'
import { readScans } from './fichiers.ts'
import { notifyMailRequestDone, notifyMailScanned } from './notifications.ts'
import { withPageCount } from './pages.ts'
import { MailStateError } from './queries.ts'

/**
 * Contenu numérisé à valider avant d'être montré au client (ADR 079) : dépôt
 * (ou remplacement), validation qui prévient le client, abandon. Chaque action
 * se protège elle-même (`requirePermission`, ADR 008) : le droit est celui du
 * courrier.
 *
 * Retour à l'écran d'où l'on vient : le traitement de la demande, ou la fiche
 * du pli pour une ouverture à l'initiative du centre.
 */
export type DepositFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

/** L'écran de traitement de la demande, sinon la fiche du pli. */
function back(target: { mailItemId: string; requestId: string | null }, notice: string): never {
  revalidatePath('/courrier', 'layout')
  revalidatePath('/compte/courrier', 'layout')
  revalidatePath('/demandes')
  redirect(
    target.requestId
      ? `/courrier/demandes/${target.requestId}?fait=${notice}`
      : `/courrier/${target.mailItemId}?fait=${notice}`,
  )
}

const UNEXPECTED =
  'Le serveur n’a pas pu enregistrer cette étape : rien n’a été modifié. Réessayez ; si cela se reproduit, prévenez la personne qui administre l’application.'

function failure(error: unknown, context: string): DepositFormState {
  unstable_rethrow(error)
  if (error instanceof MailStateError) return { error: error.message }
  console.error(`${context} : erreur imprévue`, error)
  if (error instanceof DocumentKeyError) {
    return {
      error:
        'Le fichier n’a pas été déposé : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.',
    }
  }
  return { error: UNEXPECTED }
}

/**
 * Dépôt du contenu d'une ouverture ou d'une numérisation demandée, à valider
 * ensuite. Un nouveau dépôt remplace le précédent, tant qu'il n'est pas
 * validé. Rien ne part vers le client.
 */
export async function depositContentAction(
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const { member } = await requirePermission('courrier.gerer')
  const mailItemId = text(formData, 'mailItemId')
  const requestParam = text(formData, 'requestId')
  const requestId = isUuid(requestParam) ? requestParam : null
  // Le nombre de pages saisi est rendu après un échec ; le fichier se joint de nouveau.
  const values = { contentPages: text(formData, 'contentPages') }

  // Plusieurs photos des pages font un seul PDF (ADR 055).
  const read = await readScans(formData.getAll('content'))
  if (read.error) return { fieldErrors: { content: read.error }, values }
  if (!read.scan) return { fieldErrors: { content: 'Joignez la numérisation du contenu.' }, values }
  const content = withPageCount(formData, 'content', read.scan)
  if (content.error || !content.scan) return { fieldErrors: { contentPages: content.error ?? '' }, values }

  let deposited
  try {
    deposited = await depositContent({ mailItemId, requestId }, member.id, content.scan)
  } catch (error) {
    return { ...failure(error, `Dépôt du contenu du courrier ${mailItemId}`), values }
  }
  // Rattaché à une demande (même déposé d'office) : retour à son écran de traitement.
  back({ mailItemId: deposited.mailItemId, requestId: deposited.requestId }, 'deposee')
}

/**
 * Validation : le pli est ouvert, ou la numérisation demandée faite ; le
 * client voit le document, puis il est prévenu — après la réponse, un SMTP
 * lent ne retient pas l'écran.
 */
export async function validateContentAction(
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const { member } = await requirePermission('courrier.gerer')
  const draftId = text(formData, 'draftId')
  let validated
  try {
    validated = await validateContentDraft(draftId, member.id)
  } catch (error) {
    return failure(error, `Validation du dépôt ${draftId}`)
  }
  if (validated.purpose === 'scan' && validated.requestId) {
    const requestId = validated.requestId
    after(() => notifyMailRequestDone(requestId))
  } else {
    after(() => notifyMailScanned(validated.mailItemId))
  }
  const fromRequest = text(formData, 'retour') === 'demande' && validated.requestId
  back(
    { mailItemId: validated.mailItemId, requestId: fromRequest ? validated.requestId : null },
    validated.purpose === 'scan' ? 'numerisee' : 'ouverte',
  )
}

/** Abandon d'un dépôt à valider : purgé, rien n'est publié, la demande reste en cours. */
export async function discardContentAction(
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  await requirePermission('courrier.gerer')
  const draftId = text(formData, 'draftId')
  let discarded
  try {
    discarded = await discardContentDraft(draftId)
  } catch (error) {
    return failure(error, `Abandon du dépôt ${draftId}`)
  }
  const fromRequest = text(formData, 'retour') === 'demande' && discarded.requestId
  back({ mailItemId: discarded.mailItemId, requestId: fromRequest ? discarded.requestId : null }, 'abandon')
}
