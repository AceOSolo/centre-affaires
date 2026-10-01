'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { emailEnabled, sendMessage } from '../../lib/courriel.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { amountDueCents } from './montants.ts'
import {
  dunningLevel,
  paymentFormValues,
  readCancellationReason,
  readPaymentForm,
  reminderMessage,
  type PaymentFieldErrors,
  type PaymentFormValues,
} from './paiements-regles.ts'
import {
  PaymentAmountError,
  PaymentRefusedError,
  cancelPayment,
  findInvoiceIdByNumber,
  findReminderContexts,
  recordPayment,
} from './reglements.ts'

/*
 * Actions des règlements (R16, ADR 027, ADR 030). Chacune vérifie son droit
 * elle-même : une action serveur s'invoque par son identifiant depuis
 * n'importe quel chemin (ADR 008, ADR 019).
 */

export type PaymentFormState = {
  fieldErrors?: PaymentFieldErrors
  /** Refus qui ne tient à aucun champ : facture non payable, refus de la base. */
  message?: string
  values?: PaymentFormValues
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

const settlementPath = (invoiceId: string) => `/paiements/factures/${invoiceId}`

/** Pointe un paiement reçu, ou un remboursement, sur une facture émise. */
export async function recordPaymentAction(
  _previous: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const { member } = await requirePermission('paiements.gerer')
  const invoiceId = text(formData, 'invoiceId')
  if (!isUuid(invoiceId)) return { message: 'Facture introuvable.' }

  const today = todayIsoDate(await currentTimeZone())
  const read = readPaymentForm(formData, { today })
  if ('fieldErrors' in read) return { fieldErrors: read.fieldErrors, values: read.values }

  try {
    await recordPayment(invoiceId, read.input, member.id)
  } catch (error) {
    if (error instanceof PaymentAmountError) {
      return { fieldErrors: { amount: error.message }, values: paymentFormValues(formData) }
    }
    if (error instanceof PaymentRefusedError) {
      return { message: error.message, values: paymentFormValues(formData) }
    }
    throw error
  }

  revalidatePath(settlementPath(invoiceId))
  revalidatePath(`/factures/${invoiceId}`)
  revalidatePath('/paiements')
  redirect(`${settlementPath(invoiceId)}?paiement=enregistre`)
}

export type CancelPaymentState = { error?: string } | null

/** Annule un pointage erroné ou un prélèvement rejeté : la ligne reste, avec son motif. */
export async function cancelPaymentAction(
  _previous: CancelPaymentState,
  formData: FormData,
): Promise<CancelPaymentState> {
  const { member } = await requirePermission('paiements.gerer')
  const invoiceId = text(formData, 'invoiceId')
  const paymentId = text(formData, 'paymentId')
  if (!isUuid(invoiceId) || !isUuid(paymentId)) return { error: 'Paiement introuvable.' }
  const read = readCancellationReason(formData)
  if ('error' in read) return { error: read.error }

  const cancelled = await cancelPayment({ invoiceId, paymentId, reason: read.reason, cancelledBy: member.id })
  revalidatePath(settlementPath(invoiceId))
  revalidatePath(`/factures/${invoiceId}`)
  revalidatePath('/paiements')
  redirect(`${settlementPath(invoiceId)}?paiement=${cancelled ? 'annule' : 'deja-annule'}`)
}

/** « Ouvrir une facture par son numéro » : mène à sa fiche de règlement. */
export async function openInvoiceByNumberAction(
  _previous: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string } | null> {
  await requirePermission('facturation.consulter')
  const number = text(formData, 'number')
  if (!number) return { error: 'Saisissez un numéro de facture, par exemple FA-2026-0001.' }
  const id = await findInvoiceIdByNumber(number)
  if (!id) return { error: `Aucune facture émise ne porte le numéro « ${number} ».` }
  redirect(settlementPath(id))
}

export type ReminderState = {
  error?: string
  /** Relances parties. */
  sent?: number
  /** Factures écartées, avec la raison. */
  skipped?: string[]
} | null

/**
 * Envoie par courriel la relance de chaque facture cochée, au palier que son
 * retard atteint, aux contacts « destinataire des factures » du client (à
 * défaut, à l'adresse de sa fiche). Rien ne part sans un geste de l'équipe :
 * pas d'envoi automatique (ADR 030).
 */
export async function sendRemindersAction(
  _previous: ReminderState,
  formData: FormData,
): Promise<ReminderState> {
  await requirePermission('paiements.gerer')
  if (!emailEnabled()) {
    return {
      error:
        'L’envoi de courriels n’est pas configuré sur ce serveur : aucune relance n’est partie. Imprimez-les depuis la fiche de chaque facture.',
    }
  }
  const ids = formData.getAll('invoiceIds').map(String).filter(isUuid)
  if (ids.length === 0) return { error: 'Cochez au moins une facture à relancer.' }

  const today = todayIsoDate(await currentTimeZone())
  const contexts = await findReminderContexts(ids)
  const skipped: string[] = []
  let sent = 0
  for (const { invoice, client, tenant, recipients } of contexts) {
    const number = invoice.number ?? 'brouillon'
    const due = amountDueCents(invoice)
    const level = invoice.dueDate ? dunningLevel(invoice.dueDate, today) : 0
    if (invoice.status === 'draft' || !invoice.issueDate || !invoice.dueDate || due <= 0 || level === 0) {
      skipped.push(`${number} : n’est plus en retard de paiement.`)
      continue
    }
    if (recipients.length === 0) {
      skipped.push(`${number} : ${client.name} n’a ni contact « factures » ni adresse de courriel.`)
      continue
    }
    const message = reminderMessage({
      sellerName: tenant.legalName ?? tenant.name,
      clientName: client.name,
      invoiceNumber: number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      today,
      amountDueCents: due,
      currency: invoice.currency,
      level,
      expectedPaymentMethod: invoice.expectedPaymentMethod,
      bankIban: tenant.bankIban,
      bankBic: tenant.bankBic,
      latePaymentPenaltyText: invoice.legalMentions?.latePaymentPenaltyText ?? tenant.latePaymentPenaltyText,
      recoveryIndemnityCents: invoice.legalMentions?.recoveryIndemnityCents ?? tenant.recoveryIndemnityCents,
    })
    await sendMessage({ to: recipients, ...message })
    sent++
  }
  return { sent, skipped }
}
