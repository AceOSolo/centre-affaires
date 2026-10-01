'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { readScan, type ScanFile } from './fichiers.ts'
import { notifyMailRegistered, notifyMailScanned } from './notifications.ts'
import { MailStateError, openMail, registerMail, withdrawMail } from './queries.ts'
import { mailKinds, type MailKind } from './schema.ts'

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
  const content = await readScan(formData.get('content'))
  if (content.error) fieldErrors.content = content.error

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

  // Après la réponse : un SMTP lent ne retient pas le formulaire suivant.
  after(() => notifyMailRegistered(id))
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

  const content = await readScan(formData.get('content'))
  if (content.error) return { fieldErrors: { content: content.error } }
  if (!content.scan) {
    return { fieldErrors: { content: 'Joignez la numérisation du contenu.' } }
  }

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
