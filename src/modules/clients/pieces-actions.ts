'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { notifyClientDocumentRefused } from '../notifications/declencheurs-pieces.ts'
import {
  ClientDocumentRefusal,
  moveDocumentKind,
  reviewClientDocument,
  saveDocumentKind,
  setDocumentKindActive,
} from './pieces-queries.ts'
import { parseKindInput, parseRefusalReason, type KindErrors } from './pieces-regles.ts'

/* -------------------------------------------------------------------------- */
/* Vérification d'une pièce (fiche client, devis de domiciliation)            */
/* -------------------------------------------------------------------------- */

export type ReviewState = { ok?: string; error?: string; fieldError?: string } | null

/** Écrans qui montrent les pièces d'une entreprise : la fiche, et les devis. */
function refreshScreens(clientId: string) {
  revalidatePath(`/clients/${clientId}`)
  revalidatePath('/devis/[id]', 'page')
}

/**
 * Valider une pièce (`decision=accept`) ou la refuser (`decision=refuse`),
 * avec le motif que le client lira ; un refus le prévient par courriel.
 */
export async function reviewClientDocumentAction(_previous: ReviewState, formData: FormData): Promise<ReviewState> {
  const { member } = await requirePermission('pieces.valider')
  const documentId = String(formData.get('documentId') ?? '')
  const refuse = formData.get('decision') === 'refuse'
  const reason = refuse ? parseRefusalReason(String(formData.get('reason') ?? '')) : null
  if (reason && !reason.ok) return { fieldError: reason.error }
  try {
    const review = reason?.ok ? ({ status: 'refused', reason: reason.reason } as const) : ({ status: 'accepted' } as const)
    const { clientId, kindLabel } = await reviewClientDocument(documentId, review, member.id)
    if (review.status === 'refused') after(() => notifyClientDocumentRefused(documentId))
    refreshScreens(clientId)
    return {
      ok:
        review.status === 'refused'
          ? `${kindLabel} refusée : le client est prévenu et peut en déposer une autre.`
          : `${kindLabel} validée.`,
    }
  } catch (error) {
    if (error instanceof ClientDocumentRefusal) return { error: error.message }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Liste des pièces demandées (Réglages)                                      */
/* -------------------------------------------------------------------------- */

export type KindFormState = {
  ok?: string
  error?: string
  fieldErrors?: KindErrors
  values?: { label: string; help: string; appliesTo: string }
} | null

const REGLAGES = '/reglages/pieces'

/** Ajoute une pièce à la liste (`code` vide) ou modifie celle de ce code. */
export async function saveDocumentKindAction(_previous: KindFormState, formData: FormData): Promise<KindFormState> {
  const { member } = await requirePermission('centre.configurer')
  const values = {
    label: String(formData.get('label') ?? ''),
    help: String(formData.get('help') ?? ''),
    appliesTo: String(formData.get('appliesTo') ?? ''),
  }
  const parsed = parseKindInput(values)
  if (!parsed.ok) return { fieldErrors: parsed.errors, values }
  const code = String(formData.get('code') ?? '').trim() || null
  try {
    await saveDocumentKind(code, parsed.value, member.id)
  } catch (error) {
    if (error instanceof ClientDocumentRefusal) return { error: error.message, values }
    throw error
  }
  revalidatePath(REGLAGES)
  return { ok: code ? `« ${parsed.value.label} » enregistrée.` : `« ${parsed.value.label} » ajoutée à la liste.` }
}

export type KindToggleState = { ok?: string; error?: string } | null

/** Retire une pièce de la liste, ou l'y remet. */
export async function toggleDocumentKindAction(_previous: KindToggleState, formData: FormData): Promise<KindToggleState> {
  const { member } = await requirePermission('centre.configurer')
  const code = String(formData.get('code') ?? '')
  const active = formData.get('active') === 'true'
  try {
    await setDocumentKindActive(code, active, member.id)
  } catch (error) {
    if (error instanceof ClientDocumentRefusal) return { error: error.message }
    throw error
  }
  revalidatePath(REGLAGES)
  return { ok: active ? 'Pièce remise dans la liste.' : 'Pièce retirée de la liste : elle n’est plus demandée.' }
}

/** Monte ou descend une pièce : l'ordre où le client la voit. */
export async function moveDocumentKindAction(_previous: KindToggleState, formData: FormData): Promise<KindToggleState> {
  const { member } = await requirePermission('centre.configurer')
  const direction = formData.get('direction') === 'up' ? 'up' : 'down'
  await moveDocumentKind(String(formData.get('code') ?? ''), direction, member.id)
  revalidatePath(REGLAGES)
  return { ok: direction === 'up' ? 'Pièce montée d’un rang.' : 'Pièce descendue d’un rang.' }
}

/**
 * Valider d'un coup les pièces cochées (« Valider la sélection ») : chacune
 * passe par la même règle qu'une validation seule. Rend le nombre validé et
 * les refus de la base, pièce par pièce.
 */
export async function acceptClientDocumentsAction(_previous: ReviewState, formData: FormData): Promise<ReviewState> {
  const { member } = await requirePermission('pieces.valider')
  const ids = [...new Set(formData.getAll('documentId').map(String))]
  if (ids.length === 0) return { error: 'Cochez au moins une pièce à valider.' }
  const clientIds = new Set<string>()
  const problems: string[] = []
  for (const id of ids) {
    try {
      const { clientId } = await reviewClientDocument(id, { status: 'accepted' }, member.id)
      clientIds.add(clientId)
    } catch (error) {
      if (error instanceof ClientDocumentRefusal) problems.push(error.message)
      else throw error
    }
  }
  for (const clientId of clientIds) refreshScreens(clientId)
  const accepted = ids.length - problems.length
  const done = accepted > 0 ? `${accepted} pièce${accepted > 1 ? 's' : ''} validée${accepted > 1 ? 's' : ''}.` : ''
  return problems.length > 0 ? { ok: done || undefined, error: problems.join(' ') } : { ok: done }
}
