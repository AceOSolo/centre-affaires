'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { InvoiceRefusedError } from './factures-erreurs.ts'
import {
  isIsoMonthInput,
  readCreditReason,
  readDraftInvoiceForm,
  readLineEditForm,
  readManualLineForm,
} from './factures-formulaire.ts'
import {
  NoActiveMandateError,
  abandonDraft,
  addManualLine,
  creditInFull,
  findInvoiceLine,
  issueInvoice,
  issueInvoices,
  linePriceEditable,
  prepareCreditNote,
  removeDraftLine,
  updateDraftInvoice,
  updateDraftLine,
} from './factures-queries.ts'
import { InvoiceRunInProgressError, runInvoicing } from './lot-queries.ts'

/**
 * Actions de la facturation (R13, R14, R15). Chacune vérifie son droit
 * elle-même : une action serveur s'invoque par son identifiant, depuis
 * n'importe quelle page (ADR 008, ADR 019). Facturer — lots, brouillons,
 * émission, avoirs — relève de `facturation.gerer`, réservé à l'exploitant.
 */

export type InvoiceFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

export type BulkIssueState = {
  error?: string
  issued?: { id: string; number: string }[]
  refused?: { id: string; clientName: string; message: string }[]
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

function revalidateInvoice(id: string) {
  revalidatePath('/factures')
  revalidatePath(`/factures/${id}`)
}

/** Un refus de la base devient un message ; le reste est une panne, qui remonte. */
function refusal(error: unknown): string {
  if (error instanceof InvoiceRefusedError || error instanceof NoActiveMandateError) return error.message
  throw error
}

/** Lance le lot de facturation du mois choisi, puis montre son bilan. */
export async function runInvoicingAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const { member } = await requirePermission('facturation.gerer')
  const month = text(formData, 'mois')
  if (!isIsoMonthInput(month)) return { fieldErrors: { mois: 'Choisissez un mois.' } }

  let runId: string
  try {
    runId = (await runInvoicing(month, member.id)).runId
  } catch (error) {
    if (error instanceof InvoiceRunInProgressError) return { error: error.message }
    throw error
  }
  revalidatePath('/factures')
  redirect(`/factures/preparer?mois=${month}&lot=${runId}`)
}

/** Émet les brouillons cochés dans la liste, chacun pour soi. */
export async function issueSelectedAction(
  _previous: BulkIssueState,
  formData: FormData,
): Promise<BulkIssueState> {
  const { member } = await requirePermission('facturation.gerer')
  const ids = formData.getAll('ids').map(String).filter(isUuid)
  if (ids.length === 0) return { error: 'Cochez au moins un brouillon à émettre.' }
  const result = await issueInvoices([...new Set(ids)], member.id)
  revalidatePath('/factures')
  return result
}

/** Conditions d'un brouillon : période, délai, mode de paiement, mentions. */
export async function updateDraftInvoiceAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  const read = readDraftInvoiceForm((name) => text(formData, name))
  if (!read.ok) return { fieldErrors: read.fieldErrors, values: read.values }
  try {
    await updateDraftInvoice(id, read.input)
  } catch (error) {
    if (error instanceof NoActiveMandateError) {
      return { fieldErrors: { expectedPaymentMethod: error.message }, values: read.values }
    }
    return { error: refusal(error), values: read.values }
  }
  revalidateInvoice(id)
  redirect(`/factures/${id}?fait=conditions`)
}

/** Ligne libre ou remise ajoutée à un brouillon. */
export async function addManualLineAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  const read = readManualLineForm((name) => text(formData, name))
  if (!read.ok) return { fieldErrors: read.fieldErrors, values: read.values }
  try {
    await addManualLine(id, read.input)
  } catch (error) {
    return { error: refusal(error), values: read.values }
  }
  revalidateInvoice(id)
  redirect(`/factures/${id}?fait=ligne-ajoutee#lignes`)
}

/** Désignation, quantité (et prix d'une ligne qui le permet) d'une ligne de brouillon. */
export async function updateDraftLineAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  const lineId = text(formData, 'lineId')
  if (!isUuid(id) || !isUuid(lineId)) return { error: 'Ligne introuvable.' }
  const found = await findInvoiceLine(id, lineId)
  if (!found) return { error: 'Ligne introuvable.' }
  const read = readLineEditForm((name) => text(formData, name), {
    priceEditable: linePriceEditable(found.invoice, found.line),
    exemptionEditable: found.line.vatCategory !== 'S',
  })
  if (!read.ok) return { fieldErrors: read.fieldErrors, values: read.values }
  try {
    await updateDraftLine(id, lineId, read.input)
  } catch (error) {
    return { error: refusal(error), values: read.values }
  }
  revalidateInvoice(id)
  redirect(`/factures/${id}?fait=ligne-modifiee#lignes`)
}

/** Retire une ligne d'un brouillon ; sa source redevient facturable. */
export async function removeDraftLineAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  const lineId = text(formData, 'lineId')
  if (!isUuid(id) || !isUuid(lineId)) return { error: 'Ligne introuvable.' }
  try {
    await removeDraftLine(id, lineId)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidateInvoice(id)
  redirect(`/factures/${id}?fait=ligne-retiree#lignes`)
}

/** Abandonne un brouillon : il sort de la liste, ses sources redeviennent facturables. */
export async function abandonDraftAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  try {
    await abandonDraft(id)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidatePath('/factures')
  redirect('/factures?fait=abandonne')
}

/** Émet un brouillon : numéro, date, échéance et mentions posés par la base. */
export async function issueInvoiceAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const { member } = await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  try {
    await issueInvoice(id, member.id)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidateInvoice(id)
  redirect(`/factures/${id}?fait=emise`)
}

/** Prépare un brouillon d'avoir, à réduire pour un avoir partiel. */
export async function prepareCreditNoteAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  const reason = readCreditReason(text(formData, 'reason'))
  if (!reason.ok) return { error: reason.error }
  let creditNoteId: string
  try {
    creditNoteId = await prepareCreditNote(id, reason.reason)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidateInvoice(id)
  redirect(`/factures/${creditNoteId}?fait=avoir-prepare`)
}

/** Annule une facture par un avoir total, émis aussitôt. */
export async function creditInFullAction(
  _previous: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const { member } = await requirePermission('facturation.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Facture introuvable.' }
  const reason = readCreditReason(text(formData, 'reason'))
  if (!reason.ok) return { error: reason.error }
  let creditNote: { id: string; number: string }
  try {
    creditNote = await creditInFull(id, reason.reason, member.id)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidateInvoice(id)
  revalidateInvoice(creditNote.id)
  redirect(`/factures/${creditNote.id}?fait=avoir-emis`)
}
