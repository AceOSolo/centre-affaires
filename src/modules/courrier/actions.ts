'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { DB_MAIL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { readScan, type ScanFile } from './fichiers.ts'
import { notifyMailBatchClosed, notifyMailScanned } from './notifications.ts'
import { readPageCount, withPageCount } from './pages.ts'
import { correctScanPageCount, MailStateError, openMail, registerMail, withdrawMail } from './queries.ts'
import { mailKinds, type MailKind } from './schema.ts'
import { closeOpenBatch, MailBatchClosedError } from './tournees.ts'

/**
 * Champs en erreur, par nom de champ : le formulaire affiche un résumé en tête
 * avec un lien vers chacun, et garde l'erreur à côté du champ (`CLAUDE.md`).
 */
export type MailFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Valeurs saisies, rendues au formulaire : React le réinitialise après l'envoi. */
  values?: Record<string, string>
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** Une panne du stockage ne doit pas finir sur l'écran d'erreur générique. */
function storageFailure(error: unknown): MailFormState {
  console.error('Dépôt de numérisation impossible', error)
  // Jamais de dépôt en clair faute de clé (ADR 020) : le dire, pour que l'on
  // ne réessaie pas en boucle une panne qui n'en est pas une.
  if (error instanceof DocumentKeyError) {
    return {
      error:
        'Le fichier n’a pas été déposé : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.',
    }
  }
  return {
    error:
      'Le fichier n’a pas pu être déposé. Réessayez ; si le problème persiste, le stockage est peut-être indisponible.',
  }
}

export async function registerMailAction(
  _previous: MailFormState,
  formData: FormData,
): Promise<MailFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008).
  const { member } = await requirePermission('courrier.gerer')
  const timeZone = await currentTimeZone()

  const values = {
    clientId: text(formData, 'clientId'),
    kind: text(formData, 'kind'),
    sender: text(formData, 'sender'),
    receivedAt: text(formData, 'receivedAt'),
    note: text(formData, 'note'),
    contentPages: text(formData, 'contentPages'),
  }
  const fieldErrors: Record<string, string> = {}

  if (!values.clientId) fieldErrors.clientId = 'Choisissez le destinataire.'
  const kind = mailKinds.includes(values.kind as MailKind) ? (values.kind as MailKind) : 'lettre'

  let receivedAt: Date | undefined
  try {
    receivedAt = wallClockToUtc(values.receivedAt, timeZone)
    if (receivedAt.getTime() > Date.now() + 60_000) {
      fieldErrors.receivedAt = 'La date de réception ne peut pas être dans le futur.'
    }
  } catch {
    fieldErrors.receivedAt = 'Indiquez la date et l’heure de réception.'
  }

  const envelope = await readScan(formData.get('envelope'))
  if (envelope.error) fieldErrors.envelope = envelope.error
  const read = await readScan(formData.get('content'))
  if (read.error) fieldErrors.content = read.error
  const content = withPageCount(formData, 'content', read.scan)
  if (content.error) fieldErrors.contentPages = content.error

  if (Object.keys(fieldErrors).length > 0 || !receivedAt) {
    return { fieldErrors, values }
  }

  let id: string
  try {
    id = await registerMail(
      {
        clientId: values.clientId,
        kind,
        sender: values.sender || null,
        receivedAt,
        note: values.note || null,
      },
      member.id,
      { envelope: envelope.scan, content: content.scan },
    )
  } catch (error) {
    return { ...storageFailure(error), values }
  }

  // Aucun message ici : les domiciliés sont prévenus à la fin de la tournée
  // (ADR 044), un seul message par entreprise.
  revalidatePath('/courrier')
  // Retour au formulaire vide : le courrier du jour s'enregistre à la chaîne.
  redirect(`/courrier/nouveau?enregistre=${id}`)
}

export async function openMailAction(
  _previous: MailFormState,
  formData: FormData,
): Promise<MailFormState> {
  const { member } = await requirePermission('courrier.gerer')
  const id = text(formData, 'id')
  if (!id) return { error: 'Courrier introuvable.' }

  const read = await readScan(formData.get('content'))
  if (read.error) return { fieldErrors: { content: read.error } }
  if (!read.scan) {
    return { fieldErrors: { content: 'Joignez la numérisation du contenu.' } }
  }
  const content = withPageCount(formData, 'content', read.scan)
  if (content.error || !content.scan) return { fieldErrors: { contentPages: content.error ?? '' } }

  try {
    await openMail(id, member.id, content.scan satisfies ScanFile)
  } catch (error) {
    if (error instanceof MailStateError) return { error: error.message }
    return storageFailure(error)
  }

  after(() => notifyMailScanned(id))
  revalidatePath('/courrier')
  revalidatePath(`/courrier/${id}`)
  redirect(`/courrier/${id}`)
}

export async function withdrawMailAction(formData: FormData): Promise<void> {
  await requirePermission('courrier.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await withdrawMail(id)
  revalidatePath('/courrier')
  redirect(`/courrier/${id}`)
}

/**
 * Fin de la tournée (ADR 044) : la tournée est close, puis chaque domicilié
 * reçoit son message — après la réponse, un SMTP lent ne retient pas l'écran.
 * Sans tournée ouverte, signale qu'aucun courrier n'est arrivé.
 */
export async function closeMailBatchAction(
  _previous: MailFormState,
  formData: FormData,
): Promise<MailFormState> {
  const { member } = await requirePermission('courrier.gerer')
  const expected = text(formData, 'batchId') || undefined
  let batchId: string
  try {
    batchId = await closeOpenBatch(member.id, expected)
  } catch (error) {
    if (error instanceof MailBatchClosedError) return { error: error.message }
    throw error
  }
  after(() => notifyMailBatchClosed(batchId))
  revalidatePath('/courrier')
  redirect(`/courrier/tournee?terminee=${batchId}`)
}

/**
 * Correction du nombre de pages d'un contenu par l'accueil (ADR 044), tant
 * qu'aucune facture ne le tient : la base refuse ensuite (`CA017`).
 */
export async function correctScanPagesAction(
  _previous: MailFormState,
  formData: FormData,
): Promise<MailFormState> {
  await requirePermission('courrier.gerer')
  const mailItemId = text(formData, 'mailItemId')
  const scanId = text(formData, 'scanId')
  const pages = readPageCount(text(formData, 'pages'), undefined)
  if (pages.error !== undefined) return { fieldErrors: { pages: pages.error } }
  try {
    const done = await correctScanPageCount(scanId, pages.pages)
    if (!done) return { error: 'Numérisation introuvable, ou sans compte de pages à corriger.' }
  } catch (error) {
    if (dbErrorCode(error) === DB_MAIL_REFUSED) {
      return { error: 'Ces pages sont déjà facturées : la correction passe par un avoir sur la facture.' }
    }
    throw error
  }
  revalidatePath(`/courrier/${mailItemId}`)
  redirect(`/courrier/${mailItemId}?pages=corrigees`)
}
