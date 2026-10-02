'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { can } from '../../lib/auth/permissions.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { readContractForm, type ContractField } from './formulaire.ts'
import { readLinesForm } from './lignes.ts'
import { ContractLinesRefusedError } from './lignes-queries.ts'
import { readActsForm } from './offres.ts'
import { DuplicateSubscriptionError, createContractFromOffer } from './offres-queries.ts'
import { DuplicateReferenceError } from './queries.ts'

/**
 * État rendu au formulaire « Nouveau contrat depuis une offre ». Les erreurs
 * sont rattachées à leur champ par son nom ; la saisie reste dans l'état du
 * composant.
 */
export type OfferContractFormState = {
  error?: string
  fieldErrors?: Record<string, string>
} | null

/**
 * Crée le brouillon tiré d'une offre (R09, R12) : contrat, lignes copiées de
 * l'offre et ajustées, actes inclus souscrits. Le montant du contrat découle
 * des lignes, tenu par la base. Souscrire un client à un service est un droit
 * à part (`souscriptions.gerer`, ADR 024) : il est exigé dès qu'un acte inclus
 * est retenu.
 */
export async function createContractFromOfferAction(
  _previous: OfferContractFormState,
  formData: FormData,
): Promise<OfferContractFormState> {
  const { member } = await requirePermission('contrats.creer')
  const text = (key: string) => String(formData.get(key) ?? '').trim()

  const offerId = text('offerId')
  if (!isUuid(offerId)) return { error: 'Offre introuvable.' }
  // La devise de l'offre, que ses prix supposent.
  const currency = /^[A-Z]{3}$/.test(text('currency')) ? text('currency') : 'EUR'

  // Le montant découle des lignes : il n'est pas saisi ici. Sans ligne
  // récurrente, le contrat vaut 0 € par période (actes seuls).
  const contract = readContractForm(
    (key: ContractField) => (key === 'amount' ? '0' : text(key)),
    'create',
  )
  const lines = readLinesForm(formData.getAll('ligne').map(String), text)
  const acts = readActsForm(formData.getAll('acte').map(String), text)

  const fieldErrors = {
    ...(contract.ok ? {} : contract.fieldErrors),
    ...(lines.ok ? {} : lines.fieldErrors),
    ...(acts.ok ? {} : acts.fieldErrors),
  } as Record<string, string>
  if (!contract.ok || !lines.ok || !acts.ok) return { fieldErrors }

  if (lines.lines.length === 0 && acts.subscriptions.length === 0) {
    return { error: 'Le contrat ne porte ni ligne ni acte inclus : ajoutez au moins une ligne.' }
  }
  if (acts.subscriptions.length > 0 && !can(member.role, 'souscriptions.gerer')) {
    return {
      error:
        'Souscrire les actes inclus de l’offre est réservé à l’exploitant : retirez-les, ou demandez-lui de créer le contrat.',
    }
  }

  let id: string
  try {
    id = (
      await createContractFromOffer({
        contract: { ...contract.input, offerId, currency },
        lines: lines.lines,
        subscriptions: acts.subscriptions,
        drawnBy: member.id,
      })
    ).id
  } catch (error) {
    if (error instanceof DuplicateReferenceError) {
      return { fieldErrors: { reference: error.message } }
    }
    if (error instanceof ContractLinesRefusedError || error instanceof DuplicateSubscriptionError) {
      return { error: error.message }
    }
    throw error
  }

  revalidatePath('/contrats')
  revalidatePath('/demandes')
  redirect(`/contrats/${id}?fait=cree`)
}
