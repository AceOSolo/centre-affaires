'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { notifyClientDocumentReceived } from '../notifications/declencheurs-pieces.ts'
import { requireClientAccount } from './session.ts'
import { ClientDocumentRefusal, depositClientDocument } from './pieces-queries.ts'
import { readDocumentFiles } from './pieces-regles.ts'

/** Ce que le formulaire de dépôt d'une pièce rend : chargement, puis succès ou échec. */
export type DepositState = { ok?: string; error?: string } | null

/**
 * Dépôt d'une pièce justificative depuis l'espace client (ADR 075). La pièce
 * est demandée à l'entreprise choisie, qui doit être l'une de celles du
 * compte ; le fichier est lu dans ses octets, chiffré, déposé. L'accueil est
 * prévenu après la réponse.
 */
export async function depositClientDocumentAction(_previous: DepositState, formData: FormData): Promise<DepositState> {
  const { accounts } = await requireClientAccount()
  const clientId = String(formData.get('clientId') ?? '')
  const kindCode = String(formData.get('kind') ?? '')
  const account = accounts.find((candidate) => candidate.clientId === clientId)
  if (!account) return { error: 'Cette société n’est pas rattachée à votre compte.' }

  const read = await readDocumentFiles(formData.getAll('fichier'))
  if (read.error !== undefined) return { error: read.error }

  try {
    const { id, kindLabel } = await depositClientDocument({ account, kindCode, file: read.file })
    after(() => notifyClientDocumentReceived(id))
    revalidatePath('/compte/pieces')
    revalidatePath('/compte')
    return { ok: `${kindLabel} : pièce reçue. L’équipe du centre la vérifie ; vous serez prévenu si elle doit être remplacée.` }
  } catch (error) {
    if (error instanceof ClientDocumentRefusal) return { error: error.message }
    if (error instanceof DocumentKeyError) {
      console.error('Pièce justificative non déposée : clé de chiffrement absente', error)
      return { error: 'Le dépôt de pièces est momentanément indisponible. Réessayez plus tard ou contactez le centre.' }
    }
    console.error('Pièce justificative non déposée', error)
    return { error: 'La pièce n’a pas pu être déposée. Réessayez dans un instant ; si cela persiste, contactez le centre.' }
  }
}
