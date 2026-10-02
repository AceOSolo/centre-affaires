'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { findResource } from '../ressources/queries.ts'
import { readAmendmentForm } from './avenant-formulaire.ts'
import {
  AmendmentRefusedError,
  abandonAmendment,
  createAmendment,
  findAmendment,
  signAmendment,
  updateDraftAmendment,
} from './avenants.ts'
import { occupationConflictMessage } from './conflits.ts'
import { ContractLinesRefusedError } from './lignes-queries.ts'
import { formatCalendarDate, lastContractDay } from './occupation.ts'
import { ContractOccupationConflictError, findContract } from './queries.ts'
import { findContractBilledThrough } from './versions.ts'

/** État rendu au formulaire d'avenant, et aux dialogues de signature et d'abandon. */
export type AmendmentFormState = {
  error?: string
  fieldErrors?: Record<string, string>
} | null

function revalidateContract(contractId: string) {
  revalidatePath('/contrats')
  revalidatePath(`/contrats/${contractId}`, 'layout')
  // Un avenant de ressource déplace l'occupation (ADR 025).
  revalidatePath('/reservations', 'layout')
}

/** Lit et contrôle le formulaire ; rend l'avenant à écrire ou les erreurs. */
async function readForm(contractId: string, formData: FormData) {
  const [contract, billedThrough] = await Promise.all([
    findContract(contractId),
    findContractBilledThrough(contractId),
  ])
  if (!contract) return { error: 'Contrat introuvable.' } as const
  const keys = formData.getAll('ligne').map(String)
  const read = readAmendmentForm((name) => String(formData.get(name) ?? ''), keys, {
    startsOn: contract.startsOn,
    lastDay: lastContractDay(contract),
    billedThrough,
  })
  return { read } as const
}

function refusal(error: unknown): AmendmentFormState | undefined {
  if (error instanceof AmendmentRefusedError || error instanceof ContractLinesRefusedError) {
    return { error: error.message }
  }
  return undefined
}

/**
 * Établit un avenant brouillon sur un contrat en cours (R12, ADR 025). Rien
 * n'engage avant la signature : l'avenant se relit, se modifie, s'abandonne.
 */
export async function createAmendmentAction(
  _previous: AmendmentFormState,
  formData: FormData,
): Promise<AmendmentFormState> {
  await requirePermission('contrats.avenants')
  const contractId = String(formData.get('contractId') ?? '')
  if (!isUuid(contractId)) return { error: 'Contrat introuvable.' }

  const form = await readForm(contractId, formData)
  if ('error' in form) return { error: form.error }
  if (!form.read.ok) return { fieldErrors: form.read.fieldErrors }

  let amendmentId: string
  try {
    amendmentId = (await createAmendment(contractId, form.read.input)).id
  } catch (error) {
    const state = refusal(error)
    if (state) return state
    throw error
  }

  revalidateContract(contractId)
  redirect(`/contrats/${contractId}/avenants/${amendmentId}?fait=cree`)
}

/** Modifie un avenant tant qu'il est brouillon. */
export async function updateAmendmentAction(
  _previous: AmendmentFormState,
  formData: FormData,
): Promise<AmendmentFormState> {
  await requirePermission('contrats.avenants')
  const contractId = String(formData.get('contractId') ?? '')
  const amendmentId = String(formData.get('amendmentId') ?? '')
  if (!isUuid(contractId) || !isUuid(amendmentId)) return { error: 'Avenant introuvable.' }

  const form = await readForm(contractId, formData)
  if ('error' in form) return { error: form.error }
  if (!form.read.ok) return { fieldErrors: form.read.fieldErrors }

  try {
    if (!(await updateDraftAmendment(contractId, amendmentId, form.read.input))) {
      return { error: 'Cet avenant est signé ou abandonné : il ne se modifie plus.' }
    }
  } catch (error) {
    const state = refusal(error)
    if (state) return state
    throw error
  }

  revalidateContract(contractId)
  redirect(`/contrats/${contractId}/avenants/${amendmentId}?fait=modifie`)
}

/**
 * Signature : l'avenant entre en vigueur à sa date d'effet, son document est
 * archivé avec son empreinte (ADR 025). Si la nouvelle ressource est occupée
 * après la date d'effet, la base refuse et l'écran nomme ce qui l'occupe.
 */
export async function signAmendmentAction(
  _previous: AmendmentFormState,
  formData: FormData,
): Promise<AmendmentFormState> {
  const { member } = await requirePermission('contrats.avenants')
  const contractId = String(formData.get('contractId') ?? '')
  const amendmentId = String(formData.get('amendmentId') ?? '')
  if (!isUuid(contractId) || !isUuid(amendmentId)) return { error: 'Avenant introuvable.' }

  try {
    if (!(await signAmendment(contractId, amendmentId, member.id))) {
      return { error: 'Cet avenant est déjà signé, ou a été abandonné.' }
    }
  } catch (error) {
    if (error instanceof ContractOccupationConflictError) {
      const [timeZone, resource, amendment] = await Promise.all([
        currentTimeZone(),
        error.resourceId ? findResource(error.resourceId) : undefined,
        findAmendment(contractId, amendmentId),
      ])
      const from = amendment ? `à partir du ${formatCalendarDate(amendment.effectiveOn)}` : undefined
      return { error: occupationConflictMessage(resource, error.conflicts, timeZone, from) }
    }
    const state = refusal(error)
    if (state) return state
    throw error
  }

  revalidateContract(contractId)
  redirect(`/contrats/${contractId}/avenants/${amendmentId}?fait=signe`)
}

/** Abandon d'un avenant brouillon : il ne compte plus, et reste lisible (décision 6). */
export async function abandonAmendmentAction(
  _previous: AmendmentFormState,
  formData: FormData,
): Promise<AmendmentFormState> {
  await requirePermission('contrats.avenants')
  const contractId = String(formData.get('contractId') ?? '')
  const amendmentId = String(formData.get('amendmentId') ?? '')
  if (!isUuid(contractId) || !isUuid(amendmentId)) return { error: 'Avenant introuvable.' }

  if (!(await abandonAmendment(contractId, amendmentId))) {
    return { error: 'Cet avenant est signé ou déjà abandonné.' }
  }

  revalidateContract(contractId)
  redirect(`/contrats/${contractId}/avenants/${amendmentId}?fait=abandonne`)
}
