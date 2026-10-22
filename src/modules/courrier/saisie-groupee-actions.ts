'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { readScan, type ScanFile } from './fichiers.ts'
import { EnvelopeStorageError, registerMailCountsWithEnvelopes, UnknownRecipientError } from './saisie-groupee.ts'
import {
  checkPhotoCounts,
  MAX_ENTRY_PHOTOS_BYTES,
  MAX_PER_ENTRY,
  parseMailCounts,
  photoFieldClientId,
} from './saisie-groupee-regles.ts'

export type MailCountsFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Saisie renvoyée après un échec, pour ne rien retaper. */
  values?: Record<string, string>
} | null

/**
 * Photos des enveloppes jointes ligne par ligne (ADR 055), dans l'ordre de
 * l'envoi : chacune contrôlée comme une numérisation (`readScan`). Une photo
 * refusée est une erreur sur le champ de sa ligne.
 */
async function readEnvelopePhotos(formData: FormData) {
  const photos = new Map<string, ScanFile[]>()
  const fieldErrors: Record<string, string> = {}
  let bytes = 0
  for (const [name, value] of formData.entries()) {
    const clientId = photoFieldClientId(name)
    if (!clientId || typeof value === 'string' || value.size === 0) continue
    bytes += value.size
    if (bytes > MAX_ENTRY_PHOTOS_BYTES) continue
    const read = await readScan(value)
    if (read.error) fieldErrors[name] = read.error
    if (read.scan) photos.set(clientId, [...(photos.get(clientId) ?? []), read.scan])
  }
  return { photos, fieldErrors, tooHeavy: bytes > MAX_ENTRY_PHOTOS_BYTES }
}

/**
 * Saisie groupée du courrier : tous les plis de la saisie entrent dans la
 * tournée ouverte, avec la photo de leur enveloppe quand elle est jointe,
 * puis retour à un tableau vide pour la distribution suivante.
 */
export async function registerMailCountsAction(
  _previous: MailCountsFormState,
  formData: FormData,
): Promise<MailCountsFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008).
  const { member } = await requirePermission('courrier.gerer')
  const timeZone = await currentTimeZone()

  const values: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string' && value.trim() !== '') values[name] = value
  }

  const { counts, fieldErrors, total } = parseMailCounts(formData.entries())
  const envelopes = await readEnvelopePhotos(formData)
  Object.assign(
    fieldErrors,
    envelopes.fieldErrors,
    checkPhotoCounts(counts, new Map([...envelopes.photos].map(([id, files]) => [id, files.length]))),
  )

  let receivedAt: Date | undefined
  try {
    receivedAt = wallClockToUtc(String(formData.get('receivedAt') ?? ''), timeZone)
    if (receivedAt.getTime() > Date.now() + 60_000) {
      fieldErrors.receivedAt = 'La date de réception ne peut pas être dans le futur.'
    }
  } catch {
    fieldErrors.receivedAt = 'Indiquez la date et l’heure de réception.'
  }

  if (envelopes.tooHeavy) {
    return {
      error: `Les photos dépassent ${MAX_ENTRY_PHOTOS_BYTES / 1024 / 1024} Mo à elles toutes : enregistrez la tournée en deux envois.`,
      values,
    }
  }
  if (Object.keys(fieldErrors).length > 0 || !receivedAt) return { fieldErrors, values }
  if (total === 0) {
    return { error: 'Aucun pli saisi : indiquez au moins un nombre dans le tableau.', values }
  }
  if (total > MAX_PER_ENTRY) {
    return {
      error: `${total} plis en une fois : au-delà de ${MAX_PER_ENTRY}, saisissez la tournée en deux envois.`,
      values,
    }
  }

  let done: { items: number; clients: number; envelopes: number }
  try {
    done = await registerMailCountsWithEnvelopes(counts, receivedAt, member.id, envelopes.photos)
  } catch (error) {
    if (error instanceof UnknownRecipientError) {
      return {
        error: `${error.message} Rechargez la page : rien n’a été enregistré.`,
        values,
      }
    }
    if (!(error instanceof EnvelopeStorageError)) throw error
    console.error('Dépôt de photo d’enveloppe impossible', error.cause)
    // Jamais de dépôt en clair faute de clé (ADR 020) : le dire.
    return {
      error:
        error.cause instanceof DocumentKeyError
          ? 'Rien n’a été enregistré : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.'
          : 'Rien n’a été enregistré : les photos n’ont pas pu être déposées. Réessayez ; si le problème persiste, le stockage est peut-être indisponible.',
      values,
    }
  }

  revalidatePath('/courrier')
  // `saisie` distingue deux envois identiques : le tableau revient vide à chaque fois.
  redirect(
    `/courrier/tournee/saisie?plis=${done.items}&entreprises=${done.clients}&photos=${done.envelopes}&saisie=${uuidv7()}`,
  )
}
