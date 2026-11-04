'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { canonicalSender } from './expediteurs.ts'
import { findKnownSenders } from './expediteurs-queries.ts'
import { readScan, type ScanFile } from './fichiers.ts'
import { EnvelopeStorageError, registerMailEntryWithEnvelopes, UnknownRecipientError } from './saisie-groupee.ts'
import {
  entryFieldName,
  MAX_ENTRY_PHOTOS_BYTES,
  MAX_PER_ENTRY,
  parseMailEntry,
  type EntryItem,
} from './saisie-groupee-regles.ts'

export type MailEntryFormState = {
  error?: string
  /** Par nom de champ (`pli.<clé>.<champ>`, `receivedAt`) : résumé en tête, erreur à côté du champ. */
  fieldErrors?: Record<string, string>
} | null

/**
 * Saisie groupée du courrier (ADR 058) : une photo = un pli. Tous les plis de
 * l'envoi entrent dans la tournée ouverte, chacun avec son expéditeur et la
 * photo de son enveloppe, puis retour à une saisie vide pour la distribution
 * suivante. Tout ou rien : un pli refusé, et rien n'est enregistré ; l'écran
 * garde la saisie et ses photos.
 */
export async function registerMailEntryAction(
  _previous: MailEntryFormState,
  formData: FormData,
): Promise<MailEntryFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008).
  const { member } = await requirePermission('courrier.gerer')
  const timeZone = await currentTimeZone()

  const { items, count, fieldErrors } = parseMailEntry(formData.entries())

  let receivedAt: Date | undefined
  try {
    receivedAt = wallClockToUtc(String(formData.get('receivedAt') ?? ''), timeZone)
    if (receivedAt.getTime() > Date.now() + 60_000) {
      fieldErrors.receivedAt = 'La date de réception ne peut pas être dans le futur.'
    }
  } catch {
    fieldErrors.receivedAt = 'Indiquez la date et l’heure de réception.'
  }

  if (count === 0) {
    return { error: 'Aucun pli saisi : choisissez une entreprise et un type, puis ajoutez les photos des enveloppes.' }
  }
  if (count > MAX_PER_ENTRY) {
    return { error: `${count} plis en une fois : au-delà de ${MAX_PER_ENTRY}, saisissez la tournée en deux envois.` }
  }
  const bytes = items.reduce((sum, item) => sum + (item.envelope?.size ?? 0), 0)
  if (bytes > MAX_ENTRY_PHOTOS_BYTES) {
    return {
      error: `Les photos dépassent ${MAX_ENTRY_PHOTOS_BYTES / 1024 / 1024} Mo à elles toutes : enregistrez la tournée en deux envois.`,
    }
  }

  // Chaque photo contrôlée comme une numérisation (type lu dans le fichier, poids).
  const read: EntryItem<ScanFile>[] = []
  for (const { envelope, ...item } of items) {
    if (!envelope) {
      read.push(item)
      continue
    }
    const photo = await readScan(envelope)
    if (photo.error) fieldErrors[entryFieldName(item.key, 'photo')] = photo.error
    else read.push(photo.scan ? { ...item, envelope: photo.scan } : item)
  }
  if (Object.keys(fieldErrors).length > 0 || !receivedAt) return { fieldErrors }

  // « urssaf » s'enregistre « URSSAF » : les suggestions ne se dédoublent pas.
  const known = read.some((item) => item.sender) ? await findKnownSenders() : []
  const entry = read.map((item) => ({ ...item, sender: item.sender && canonicalSender(item.sender, known) }))

  let done: { items: number; clients: number; envelopes: number }
  try {
    done = await registerMailEntryWithEnvelopes(entry, receivedAt, member.id)
  } catch (error) {
    if (error instanceof UnknownRecipientError) {
      return { error: `${error.message} Rechargez la page : rien n’a été enregistré.` }
    }
    if (!(error instanceof EnvelopeStorageError)) throw error
    console.error('Dépôt de photo d’enveloppe impossible', error.cause)
    // Jamais de dépôt en clair faute de clé (ADR 020) : le dire.
    return {
      error:
        error.cause instanceof DocumentKeyError
          ? 'Rien n’a été enregistré : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.'
          : 'Rien n’a été enregistré : les photos n’ont pas pu être déposées. Réessayez ; si le problème persiste, le stockage est peut-être indisponible.',
    }
  }

  revalidatePath('/courrier', 'layout')
  // `saisie` distingue deux envois identiques : l'écran revient vide à chaque fois.
  redirect(
    `/courrier/tournee/saisie?plis=${done.items}&entreprises=${done.clients}&photos=${done.envelopes}&saisie=${uuidv7()}`,
  )
}
