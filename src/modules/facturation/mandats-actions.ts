'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { InvalidIbanError } from './iban.ts'
import {
  ActiveMandateExistsError,
  MandateClientUnavailableError,
  createMandate,
  revokeMandate,
} from './mandats.ts'
import { readMandateForm, type MandateFieldErrors, type MandateFormValues } from './mandats-regles.ts'

/*
 * Mandats de prélèvement SEPA d'un client (R16, ADR 027, ADR 030), droit
 * `paiements.gerer`. L'IBAN saisi ne revient jamais dans une réponse : ni
 * dans les valeurs rendues au formulaire, ni dans un message, ni dans un
 * journal.
 */

export type MandateFormState = {
  fieldErrors?: MandateFieldErrors
  message?: string
  /** Sans l'IBAN, jamais renvoyé au navigateur. */
  values?: MandateFormValues
  /** Mandat enregistré : sa RUM, à reporter sur le formulaire papier. */
  created?: string
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export async function createMandateAction(
  _previous: MandateFormState,
  formData: FormData,
): Promise<MandateFormState> {
  await requirePermission('paiements.gerer')
  const clientId = text(formData, 'clientId')
  if (!isUuid(clientId)) return { message: 'Fiche client introuvable.' }

  const today = todayIsoDate(await currentTimeZone())
  const read = readMandateForm(formData, { today })
  if ('fieldErrors' in read) return { fieldErrors: read.fieldErrors, values: read.values }
  const values: MandateFormValues = {
    debtorName: read.input.debtorName,
    bic: read.input.bic ?? '',
    signedOn: read.input.signedOn,
    sequenceType: read.input.sequenceType,
  }

  let reference: string
  try {
    reference = (await createMandate(clientId, read.input, today)).reference
  } catch (error) {
    if (error instanceof ActiveMandateExistsError || error instanceof MandateClientUnavailableError) {
      return { message: error.message, values }
    }
    if (error instanceof InvalidIbanError) return { fieldErrors: { iban: error.message }, values }
    if (error instanceof DocumentKeyError) {
      // Jamais d'IBAN en clair faute de clé (ADR 020, ADR 027).
      return {
        message:
          'Le mandat n’a pas été enregistré : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.',
        values,
      }
    }
    throw error
  }

  revalidatePath(`/clients/${clientId}`)
  return { created: reference }
}

/** Révoque le mandat actif d'un client, au jour du centre. */
export async function revokeMandateAction(
  _previous: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string } | null> {
  await requirePermission('paiements.gerer')
  const clientId = text(formData, 'clientId')
  const mandateId = text(formData, 'mandateId')
  if (!isUuid(clientId) || !isUuid(mandateId)) return { error: 'Mandat introuvable.' }
  const today = todayIsoDate(await currentTimeZone())
  const revoked = await revokeMandate(clientId, mandateId, today)
  if (!revoked) return { error: 'Ce mandat n’est plus actif : il a déjà été révoqué.' }
  revalidatePath(`/clients/${clientId}`)
  redirect(`/clients/${clientId}#mandats`)
}
