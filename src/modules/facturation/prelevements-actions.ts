'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { checkCollectionDate } from './mandats-regles.ts'
import { RemittanceError, prepareDirectDebitRemittance } from './prelevements.ts'

export type RemittanceFormState = {
  error?: string
  /** Ce qui empêche la remise, facture par facture. */
  problems?: string[]
} | null

/**
 * Prépare une remise de prélèvements (R16, ADR 028) : les factures cochées
 * sont marquées d'un paiement par prélèvement, puis l'écran propose le
 * fichier à déposer à la banque.
 */
export async function prepareRemittanceAction(
  _previous: RemittanceFormState,
  formData: FormData,
): Promise<RemittanceFormState> {
  const { member } = await requirePermission('paiements.gerer')
  const today = todayIsoDate(await currentTimeZone())
  const collectionDate = String(formData.get('collectionDate') ?? '').trim()
  const dateError = checkCollectionDate(collectionDate, today)
  if (dateError) return { error: dateError }
  const invoiceIds = formData.getAll('invoiceIds').map(String).filter(isUuid)
  if (invoiceIds.length === 0) return { error: 'Cochez au moins une facture à prélever.' }

  let remittanceId: string
  try {
    remittanceId = (
      await prepareDirectDebitRemittance({ invoiceIds, collectionDate, today, recordedBy: member.id })
    ).remittanceId
  } catch (error) {
    if (error instanceof RemittanceError) {
      return { error: 'La remise n’a pas été préparée, rien n’a été marqué :', problems: error.problems }
    }
    throw error
  }

  revalidatePath('/paiements')
  revalidatePath('/paiements/prelevements')
  redirect(`/paiements/prelevements?remise=${remittanceId}&date=${collectionDate}`)
}
