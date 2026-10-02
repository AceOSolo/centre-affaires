'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'

import { todayIsoDate } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { notifyContractActivated } from '../notifications/declencheurs-clients.ts'
import { findResource } from '../ressources/queries.ts'
import { occupationConflictMessage } from './conflits.ts'
import { noticeEndsOn } from './echeancier.ts'
import { isCalendarDate, readContractForm, type ContractField } from './formulaire.ts'
import {
  ContractAlreadyStartedError,
  ContractClientLockedError,
  ContractOccupationConflictError,
  DuplicateReferenceError,
  activateContract,
  archiveContract,
  changeContractResource,
  createContract,
  findContract,
  restoreContract,
  terminateContract,
  updateDraftContract,
} from './queries.ts'

/**
 * État rendu aux formulaires de contrat. `fieldErrors` rattache chaque erreur
 * à son champ, affichée à côté et reprise dans le résumé en tête ; `values`
 * rend la saisie, que React efface à la fin de l'envoi.
 */
export type FormState = {
  error?: string
  fieldErrors?: Partial<Record<string, string>>
  values?: Record<string, string>
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** Le conflit d'occupation, nommé : ressource, ce qui l'occupe, que faire. */
async function conflictMessage(error: ContractOccupationConflictError): Promise<string> {
  const [timeZone, resource] = await Promise.all([
    currentTimeZone(),
    error.resourceId ? findResource(error.resourceId) : undefined,
  ])
  return occupationConflictMessage(resource, error.conflicts, timeZone)
}

function revalidateContract(id: string) {
  revalidatePath('/contrats')
  revalidatePath(`/contrats/${id}`)
  // L'occupation apparaît ou disparaît des calendriers (ADR 018).
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
}

export async function createContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('contrats.creer')
  const read = readContractForm((key: ContractField) => text(formData, key), 'create')
  if (!read.ok) return { fieldErrors: read.fieldErrors, values: read.values }

  let id: string
  try {
    // Référence omise : la base attribue le numéro suivant (ADR 021).
    id = (await createContract(read.input)).id
  } catch (error) {
    if (error instanceof DuplicateReferenceError) {
      return { fieldErrors: { reference: error.message }, values: read.values }
    }
    throw error
  }

  revalidatePath('/contrats')
  redirect(`/contrats/${id}?fait=cree`)
}

/**
 * Modification d'un brouillon (R12), avec les mêmes règles que la création.
 * Un brouillon n'occupe rien : changer sa ressource ne peut pas entrer en
 * conflit, c'est l'activation qui le dira.
 */
export async function updateContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.creer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  const read = readContractForm((key: ContractField) => text(formData, key), 'update')
  if (!read.ok) return { fieldErrors: read.fieldErrors, values: read.values }

  try {
    const updated = await updateDraftContract(id, {
      ...read.input,
      reference: read.values.reference,
    })
    if (!updated) {
      return {
        error:
          'Ce contrat n’est plus un brouillon, ou il a été archivé : il ne se modifie plus ici.',
        values: read.values,
      }
    }
  } catch (error) {
    if (error instanceof DuplicateReferenceError) {
      return { fieldErrors: { reference: error.message }, values: read.values }
    }
    if (error instanceof ContractClientLockedError) {
      return { fieldErrors: { clientId: error.message }, values: read.values }
    }
    throw error
  }

  revalidateContract(id)
  redirect(`/contrats/${id}?fait=modifie`)
}

/**
 * Activation : le contrat devient facturable et occupe sa ressource. Si la
 * ressource est déjà prise sur la période, la base refuse et le contrat reste
 * en brouillon ; l'écran nomme ce qui l'occupe.
 */
export async function activateContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { member } = await requirePermission('contrats.activer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  try {
    // Le document du contrat est archivé dans la même transaction (ADR 025).
    if (!(await activateContract(id, member.id))) {
      return { error: 'Ce contrat n’est plus un brouillon : il ne peut pas être activé.' }
    }
  } catch (error) {
    if (error instanceof ContractOccupationConflictError) {
      return { error: await conflictMessage(error) }
    }
    throw error
  }

  // Le client est prévenu que son contrat est en vigueur (ADR 038).
  after(() => notifyContractActivated(id))
  revalidateContract(id)
  redirect(`/contrats/${id}?fait=active`)
}

/**
 * Changement de ressource d'un contrat en cours qui n'a pas commencé :
 * l'occupation suit (ADR 018). Vers une ressource déjà occupée, la base
 * refuse ; l'erreur revient sous le champ. Un contrat commencé ne change pas de
 * ressource par ce chemin : le message oriente vers l'avenant (ADR 025).
 */
export async function changeContractResourceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.activer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }
  const resourceId = text(formData, 'resourceId')
  const values = { resourceId }
  if (resourceId && !isUuid(resourceId)) {
    return { fieldErrors: { resourceId: 'Ressource inconnue.' }, values }
  }

  try {
    if (!(await changeContractResource(id, resourceId || null))) {
      return {
        error: 'Seul un contrat en cours change de ressource ici.',
        values,
      }
    }
  } catch (error) {
    if (error instanceof ContractOccupationConflictError) {
      return { fieldErrors: { resourceId: await conflictMessage(error) }, values }
    }
    if (error instanceof ContractAlreadyStartedError) {
      return { error: error.message, values }
    }
    throw error
  }

  revalidateContract(id)
  redirect(`/contrats/${id}?fait=ressource`)
}

/**
 * Archivage (décision 6) : jamais de suppression physique. Le contrat reste
 * consultable par son adresse et dans le filtre « Archivés ».
 */
export async function archiveContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.archiver')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  if (!(await archiveContract(id))) {
    return { error: 'Ce contrat est déjà archivé.' }
  }

  revalidateContract(id)
  redirect(`/contrats/${id}?fait=archive`)
}

/** Désarchivage : le contrat revient dans les listes, son occupation aussi. */
export async function restoreContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.archiver')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  try {
    if (!(await restoreContract(id))) {
      return { error: 'Ce contrat n’est pas archivé.' }
    }
  } catch (error) {
    if (error instanceof ContractOccupationConflictError) {
      return { error: await conflictMessage(error) }
    }
    if (error instanceof DuplicateReferenceError) {
      return {
        error: `${error.message} Changez la référence de l’autre contrat avant de désarchiver celui-ci.`,
      }
    }
    throw error
  }

  revalidateContract(id)
  redirect(`/contrats/${id}?fait=restaure`)
}

/**
 * Pourquoi ce contrat ne se résilie pas, ou `undefined` s'il le peut : seul un
 * contrat en cours, non archivé, se résilie (`terminateContract`).
 */
function terminationRefusal(contract: { status: string; deletedAt: Date | null }) {
  if (contract.deletedAt !== null) return 'Ce contrat est archivé : il ne se résilie plus.'
  if (contract.status === 'draft') {
    return 'Un brouillon ne se résilie pas : il n’a engagé personne. S’il est abandonné, archivez-le.'
  }
  if (contract.status === 'terminated') return 'Ce contrat est déjà résilié.'
  return undefined
}

/**
 * Résiliation d'un contrat en cours. La date de fin proposée par défaut est
 * celle du préavis ; le staff peut la remplacer — une résiliation d'un commun
 * accord s'affranchit du préavis.
 */
export async function terminateContractAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('contrats.resilier')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  const contract = await findContract(id)
  if (!contract) return { error: 'Contrat introuvable.' }
  const refusal = terminationRefusal(contract)
  if (refusal) return { error: refusal }

  const requested = text(formData, 'terminatedOn')
  const terminatedOn = isCalendarDate(requested)
    ? requested
    : noticeEndsOn(todayIsoDate(await currentTimeZone()), contract.noticeDays)

  if (terminatedOn < contract.startsOn) {
    return { error: 'La résiliation ne peut pas précéder le début du contrat.' }
  }

  try {
    // Le filtre de la requête tranche : le contrat a pu changer depuis la
    // lecture ci-dessus.
    if (!(await terminateContract(id, terminatedOn, text(formData, 'reason') || null))) {
      return { error: 'Ce contrat n’est plus en cours : il ne peut pas être résilié.' }
    }
  } catch (error) {
    if (error instanceof ContractOccupationConflictError) {
      return { error: await conflictMessage(error) }
    }
    throw error
  }
  revalidateContract(id)
  redirect(`/contrats/${id}?fait=resilie`)
}
