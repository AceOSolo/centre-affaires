'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { isIsoDate } from './saisie.ts'
import {
  SubscriptionRefusedError,
  cancelSubscription,
  changeSubscriptionConditions,
  findSubscription,
  listSubscribableServices,
  listSubscriptionContracts,
  setSubscriptionEnd,
  subscribe,
} from './souscriptions-queries.ts'
import {
  readSubscriptionForm,
  readTerms,
  subscriptionValues,
  type SubscriptionFieldErrors,
  type SubscriptionValues,
} from './souscriptions-regles.ts'

export type SubscriptionFormState = {
  fieldErrors?: SubscriptionFieldErrors
  /** Refus qui ne tient à aucun champ : chevauchement, jour déjà facturé. */
  message?: string
  values?: SubscriptionValues
} | null

/** Retour sur la fiche client, à la section des services souscrits. */
function backToClient(clientId: string, notice: string): never {
  revalidatePath(`/clients/${clientId}`)
  redirect(`/clients/${clientId}?souscription=${notice}#services`)
}

/**
 * Souscrire un client à un service (R18). Réservé à l'exploitant
 * (`souscriptions.gerer`) : une souscription engage un prix (ADR 024).
 */
export async function subscribeAction(
  _previous: SubscriptionFormState,
  formData: FormData,
): Promise<SubscriptionFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008, ADR 019).
  await requirePermission('souscriptions.gerer')
  const clientId = String(formData.get('clientId') ?? '')
  if (!isUuid(clientId)) return { message: 'Fiche client introuvable.' }

  const [services, contracts] = await Promise.all([
    listSubscribableServices(),
    listSubscriptionContracts(clientId),
  ])
  const read = readSubscriptionForm(formData, {
    services: services.map((service) => ({
      id: service.id,
      nature: service.nature,
      isActive: service.isActive,
      archived: service.deletedAt !== null,
    })),
    contractIds: contracts.map((contract) => contract.id),
  })
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values: read.values }

  try {
    await subscribe(clientId, read.input)
  } catch (error) {
    if (error instanceof SubscriptionRefusedError) {
      return { message: error.message, values: read.values }
    }
    throw error
  }
  backToClient(clientId, 'ajoutee')
}

/**
 * Nouvelles conditions (quantité, prix, remise, TVA, inclus) à compter d'une
 * date : la souscription en cours prend fin la veille, une nouvelle la suit.
 */
export async function changeSubscriptionAction(
  _previous: SubscriptionFormState,
  formData: FormData,
): Promise<SubscriptionFormState> {
  await requirePermission('souscriptions.gerer')
  const id = String(formData.get('id') ?? '')
  const subscription = isUuid(id) ? await findSubscription(id) : undefined
  if (!subscription) return { message: 'Souscription introuvable.' }

  const values = subscriptionValues(formData)
  const { terms, errors } = readTerms(values, subscription.service.nature)
  const fieldErrors: SubscriptionFieldErrors = { ...errors }
  if (!isIsoDate(values.effectiveOn)) {
    fieldErrors.effectiveOn = 'Saisissez le jour où les nouvelles conditions s’appliquent.'
  }
  if (Object.keys(fieldErrors).length > 0 || !terms) return { fieldErrors, values }

  try {
    await changeSubscriptionConditions(id, values.effectiveOn, terms, values.notes || null)
  } catch (error) {
    if (error instanceof SubscriptionRefusedError) return { message: error.message, values }
    throw error
  }
  backToClient(subscription.clientId, 'modifiee')
}

export type SubscriptionEndState = { message?: string; endsOn?: string } | null

/** Fixe, déplace ou retire la date de fin d'une souscription. */
export async function endSubscriptionAction(
  _previous: SubscriptionEndState,
  formData: FormData,
): Promise<SubscriptionEndState> {
  await requirePermission('souscriptions.gerer')
  const id = String(formData.get('id') ?? '')
  const subscription = isUuid(id) ? await findSubscription(id) : undefined
  if (!subscription) return { message: 'Souscription introuvable.' }

  const endsOn = String(formData.get('endsOn') ?? '').trim()
  if (endsOn && !isIsoDate(endsOn)) return { message: 'Date de fin illisible.', endsOn }

  try {
    await setSubscriptionEnd(id, endsOn || null)
  } catch (error) {
    if (error instanceof SubscriptionRefusedError) return { message: error.message, endsOn }
    throw error
  }
  backToClient(subscription.clientId, endsOn ? 'terminee' : 'prolongee')
}

/** Au format du dialogue de confirmation (`ConfirmDialog`). */
export type SubscriptionCancelState = { error?: string } | null

/** Annulation d'une souscription jamais facturée (archivage, décision 6). */
export async function cancelSubscriptionAction(
  _previous: SubscriptionCancelState,
  formData: FormData,
): Promise<SubscriptionCancelState> {
  await requirePermission('souscriptions.gerer')
  const id = String(formData.get('id') ?? '')
  const subscription = isUuid(id) ? await findSubscription(id) : undefined
  if (!subscription) return { error: 'Souscription introuvable.' }

  try {
    await cancelSubscription(id)
  } catch (error) {
    if (error instanceof SubscriptionRefusedError) return { error: error.message }
    throw error
  }
  backToClient(subscription.clientId, 'annulee')
}
