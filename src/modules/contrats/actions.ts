'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import { parseAmountToCents } from '../facturation/tarifs.ts'
import { noticeEndsOn } from './echeancier.ts'
import {
  DuplicateReferenceError,
  activateContract,
  createContract,
  findContract,
  terminateContract,
} from './queries.ts'
import {
  billingPeriods,
  contractTypes,
  type BillingPeriod,
  type ContractType,
} from './schema.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function createContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('contrats.creer')
  const clientId = text(formData, 'clientId')
  const reference = text(formData, 'reference')
  const contractType = text(formData, 'contractType')
  const billingPeriod = text(formData, 'billingPeriod')
  const startsOn = text(formData, 'startsOn')
  const endsOn = text(formData, 'endsOn')

  if (!clientId) return { error: 'Choisir un client.' }
  if (!reference) return { error: 'Indiquer une référence de contrat.' }
  if (!contractTypes.includes(contractType as ContractType)) {
    return { error: 'Type de contrat inconnu.' }
  }
  if (!billingPeriods.includes(billingPeriod as BillingPeriod)) {
    return { error: 'Périodicité de facturation inconnue.' }
  }
  if (!ISO_DATE.test(startsOn)) return { error: 'Date de début illisible.' }
  if (endsOn && !ISO_DATE.test(endsOn)) return { error: 'Date de fin illisible.' }
  if (endsOn && endsOn < startsOn) {
    return { error: 'La date de fin doit être postérieure à la date de début.' }
  }

  // Le montant est saisi en euros et stocké en centimes (décision 5).
  const amountCents = parseAmountToCents(text(formData, 'amount'))
  if (amountCents === undefined) {
    return { error: 'Montant illisible. Exemple : 900,00' }
  }

  const noticeDays = Number(text(formData, 'noticeDays') || '90')
  if (!Number.isInteger(noticeDays) || noticeDays < 0) {
    return { error: 'Le préavis doit être un nombre de jours positif.' }
  }

  let id: string
  try {
    id = (
      await createContract({
        clientId,
        reference,
        contractType: contractType as ContractType,
        billingPeriod: billingPeriod as BillingPeriod,
        startsOn,
        endsOn: endsOn || null,
        amountCents,
        ratePlanId: text(formData, 'ratePlanId') || null,
        resourceId: text(formData, 'resourceId') || null,
        noticeDays,
        notes: text(formData, 'notes') || null,
      })
    ).id
  } catch (error) {
    if (error instanceof DuplicateReferenceError) return { error: error.message }
    throw error
  }

  revalidatePath('/contrats')
  redirect(`/contrats/${id}`)
}

export async function activateContractAction(formData: FormData): Promise<void> {
  await requirePermission('contrats.activer')
  const id = text(formData, 'id')
  if (!id) return
  await activateContract(id)
  revalidatePath('/contrats')
  revalidatePath(`/contrats/${id}`)
}

/**
 * Résiliation. La date de fin proposée par défaut est celle du préavis ; le
 * staff peut la remplacer — une résiliation d'un commun accord s'affranchit du
 * préavis.
 */
export async function terminateContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.resilier')
  const id = text(formData, 'id')
  if (!id) return { error: 'Contrat introuvable.' }

  const contract = await findContract(id)
  if (!contract) return { error: 'Contrat introuvable.' }

  const requested = text(formData, 'terminatedOn')
  const terminatedOn = ISO_DATE.test(requested)
    ? requested
    : noticeEndsOn(new Date().toISOString().slice(0, 10), contract.noticeDays)

  if (terminatedOn < contract.startsOn) {
    return { error: 'La résiliation ne peut pas précéder le début du contrat.' }
  }

  await terminateContract(id, terminatedOn, text(formData, 'reason') || null)
  revalidatePath('/contrats')
  revalidatePath(`/contrats/${id}`)
  return null
}
