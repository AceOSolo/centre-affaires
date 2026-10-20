'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { listClients } from '../clients/queries.ts'
import { answerFieldName, parseAnswers, questionnaires, type Answers } from '../reservations/questionnaires.ts'
import { createStaffProposal, StaffProposalError } from './propositions-accueil-queries.ts'
import {
  MAX_CANCEL_REASON_LENGTH,
  MAX_NOTE_LENGTH,
  lineFormValues,
  parseManualLine,
  parseRequester,
  parseServiceLine,
  requesterFormValues,
  type LineFormErrors,
  type LineFormValues,
  type RequesterFormValues,
} from './propositions-ecran.ts'
import {
  ProposalRefusedError,
  addProposalLine,
  cancelProposal,
  findProposal,
  findServiceForProposal,
  removeProposalLine,
  reopenProposal,
  updateProposalLine,
  updateProposalNote,
  validateProposal,
} from './propositions-queries.ts'
import { proposalProducts, type ProposalProduct } from './schema-devis.ts'

/**
 * Actions de l'accueil sur les devis (ADR 043). Chacune vérifie le droit
 * (`demandes.traiter`, ADR 019), relit sa saisie, et traduit les refus de la
 * base (`ProposalRefusedError`, `CA016`) en message affiché. Le succès
 * redirige vers la fiche, qui l'annonce (`?enregistre=`).
 */

/** État des petites actions (`ConfirmDialog`, boutons) : une erreur, ou rien. */
export type ProposalActionState = { error?: string } | null

const NOT_FOUND = 'Ce devis est introuvable : il a peut-être été retiré.'
const NOT_DRAFT = 'Ce devis n’est plus un brouillon : remettez-le en brouillon pour le modifier.'

function revalidateProposal(proposalId: string, bookingId?: string | null) {
  revalidatePath('/devis')
  revalidatePath(`/devis/${proposalId}`)
  if (bookingId) revalidatePath(`/reservations/${bookingId}`)
}

function refusedMessage(error: unknown): string {
  if (error instanceof ProposalRefusedError || error instanceof StaffProposalError) return error.message
  throw error
}

// --- Lignes ------------------------------------------------------------------

export type LineFormState = {
  fieldErrors?: LineFormErrors
  message?: string
  values?: LineFormValues
} | null

/** Ajoute une ligne (catalogue ou saisie), ou modifie celle que porte `lineId`. */
export async function saveProposalLineAction(_previous: LineFormState, formData: FormData): Promise<LineFormState> {
  await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  const lineId = String(formData.get('lineId') ?? '') || null
  if (!isUuid(proposalId) || (lineId !== null && !isUuid(lineId))) return { message: NOT_FOUND }

  const values = lineFormValues(formData)
  const proposal = await findProposal(proposalId)
  if (!proposal) return { message: NOT_FOUND, values }
  if (proposal.status !== 'draft') return { message: NOT_DRAFT, values }

  try {
    if (lineId) {
      if (!proposal.lines.some((line) => line.id === lineId)) {
        return { message: 'Cette ligne a été retirée du devis entre-temps.', values }
      }
      const { line, errors } = parseManualLine(values)
      if (!line) return { fieldErrors: errors, values }
      await updateProposalLine(proposalId, lineId, line)
    } else if (values.mode === 'service') {
      const service = values.serviceId && isUuid(values.serviceId) ? await findServiceForProposal(values.serviceId) : undefined
      const { line, errors } = parseServiceLine(values, service)
      if (!line) return { fieldErrors: errors, values }
      await addProposalLine(proposalId, line)
    } else {
      const { line, errors } = parseManualLine(values)
      if (!line) return { fieldErrors: errors, values }
      await addProposalLine(proposalId, {
        ...line,
        source: 'manual',
        resourceId: null,
        serviceId: null,
        ratePlanItemId: null,
      })
    }
  } catch (error) {
    return { message: refusedMessage(error), values }
  }

  revalidateProposal(proposalId)
  redirect(`/devis/${proposalId}?enregistre=${lineId ? 'ligne-modifiee' : 'ligne-ajoutee'}#lignes`)
}

export async function removeProposalLineAction(
  _previous: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  const lineId = String(formData.get('lineId') ?? '')
  if (!isUuid(proposalId) || !isUuid(lineId)) return { error: NOT_FOUND }
  try {
    await removeProposalLine(proposalId, lineId)
  } catch (error) {
    return { error: refusedMessage(error) }
  }
  revalidateProposal(proposalId)
  redirect(`/devis/${proposalId}?enregistre=ligne-retiree#lignes`)
}

// --- Note de l'accueil -------------------------------------------------------

export type NoteFormState = { error?: string; values?: { staffNote: string } } | null

export async function saveProposalNoteAction(_previous: NoteFormState, formData: FormData): Promise<NoteFormState> {
  await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  const staffNote = String(formData.get('staffNote') ?? '').trim()
  if (!isUuid(proposalId)) return { error: NOT_FOUND }
  if (staffNote.length > MAX_NOTE_LENGTH) {
    return { error: `${MAX_NOTE_LENGTH} caractères au plus.`, values: { staffNote } }
  }
  const proposal = await findProposal(proposalId)
  if (!proposal) return { error: NOT_FOUND, values: { staffNote } }
  if (proposal.status !== 'draft') return { error: NOT_DRAFT, values: { staffNote } }
  try {
    await updateProposalNote(proposalId, staffNote)
  } catch (error) {
    return { error: refusedMessage(error), values: { staffNote } }
  }
  revalidateProposal(proposalId)
  redirect(`/devis/${proposalId}?enregistre=note#note`)
}

// --- Cycle du devis ----------------------------------------------------------

/** L'accueil valide le brouillon : il passe « prêt », Dolibarr le reprendra. */
export async function validateProposalAction(
  _previous: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  const { member } = await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  if (!isUuid(proposalId)) return { error: NOT_FOUND }
  let bookingId: string | null = null
  try {
    const proposal = await findProposal(proposalId)
    if (!proposal) return { error: NOT_FOUND }
    bookingId = proposal.bookingId
    if (proposal.lines.length === 0) return { error: 'Aucune ligne : ajoutez le prix avant de valider.' }
    if (!(await validateProposal(proposalId, member.id))) {
      return { error: 'Ce devis n’est plus un brouillon : rechargez la page.' }
    }
  } catch (error) {
    return { error: refusedMessage(error) }
  }
  revalidateProposal(proposalId, bookingId)
  redirect(`/devis/${proposalId}?enregistre=valide`)
}

/** Un devis prêt, pas encore repris par Dolibarr, revient en brouillon. */
export async function reopenProposalAction(
  _previous: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  if (!isUuid(proposalId)) return { error: NOT_FOUND }
  try {
    if (!(await reopenProposal(proposalId))) {
      return { error: 'Dolibarr a déjà repris ce devis, ou il n’est plus prêt : rechargez la page.' }
    }
  } catch (error) {
    return { error: refusedMessage(error) }
  }
  revalidateProposal(proposalId)
  redirect(`/devis/${proposalId}?enregistre=brouillon`)
}

/** Annulation, motif obligatoire : il est transmis à Dolibarr et reste sur la fiche. */
export async function cancelProposalAction(
  _previous: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  await requirePermission('demandes.traiter')
  const proposalId = String(formData.get('proposalId') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()
  if (!isUuid(proposalId)) return { error: NOT_FOUND }
  if (!reason) return { error: 'Saisissez le motif de l’annulation.' }
  if (reason.length > MAX_CANCEL_REASON_LENGTH) return { error: `Motif : ${MAX_CANCEL_REASON_LENGTH} caractères au plus.` }
  let bookingId: string | null = null
  try {
    const proposal = await findProposal(proposalId)
    if (!proposal) return { error: NOT_FOUND }
    bookingId = proposal.bookingId
    if (!(await cancelProposal(proposalId, reason))) {
      return { error: 'Ce devis est déjà clos : rechargez la page.' }
    }
  } catch (error) {
    return { error: refusedMessage(error) }
  }
  revalidateProposal(proposalId, bookingId)
  redirect(`/devis/${proposalId}?enregistre=annule`)
}

// --- Devis établi par l'accueil ----------------------------------------------

export type NewProposalFormState = {
  fieldErrors?: Record<string, string>
  message?: string
  values?: { requester: RequesterFormValues; answers: Answers; reservation: string }
} | null

/**
 * Devis établi par l'accueil : produit, réservation (espace, véhicule),
 * destinataire, réponses au questionnaire. Il naît brouillon (canal
 * `staff`) : l'accueil le relit et le valide sur sa fiche.
 */
export async function createStaffProposalAction(
  _previous: NewProposalFormState,
  formData: FormData,
): Promise<NewProposalFormState> {
  await requirePermission('demandes.traiter')
  const productValue = String(formData.get('product') ?? '')
  if (!(proposalProducts as readonly string[]).includes(productValue)) {
    return { message: 'Choisissez d’abord ce que le devis propose.' }
  }
  const product = productValue as ProposalProduct
  const reservation = String(formData.get('reservation') ?? '').trim()
  const requesterValues = requesterFormValues(formData)
  const { answers, errors: answerErrors } = parseAnswers(product, formData)
  const values = { requester: requesterValues, answers, reservation }

  const clients = await listClients()
  const { requester, errors: requesterErrors } = parseRequester(requesterValues, new Set(clients.map((client) => client.id)))
  const fieldErrors: Record<string, string> = { ...(requesterErrors as Record<string, string>) }
  const needsBooking = questionnaires[product].resourceTypes.length > 0
  if (needsBooking && !reservation) fieldErrors.reservation = 'Choisissez la réservation à chiffrer.'
  else if (needsBooking && !isUuid(reservation)) fieldErrors.reservation = 'Cette réservation est introuvable.'
  for (const [question, message] of Object.entries(answerErrors)) fieldErrors[answerFieldName({ name: question })] = message
  if (Object.keys(fieldErrors).length > 0 || !requester) return { fieldErrors, values }

  const tenant = await currentTenant()
  let created: { id: string }
  try {
    created = await createStaffProposal({
      product,
      bookingId: needsBooking ? reservation : null,
      ...requester,
      answers,
      currency: tenant.currency,
      timeZone: tenant.timezone,
    })
  } catch (error) {
    return { message: refusedMessage(error), values }
  }
  revalidateProposal(created.id, needsBooking ? reservation : null)
  redirect(`/devis/${created.id}?enregistre=cree`)
}
