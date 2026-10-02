'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import { isValidEmail, normaliseEmail, normalisePhone } from './contacts-regles.ts'
import { DuplicateSiretError, archiveClient, createClient, updateClient } from './queries.ts'
import { clientStatuses, type ClientStatus } from './schema.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

function optional(formData: FormData, key: string): string | null {
  return text(formData, key) || null
}

/** Le SIRET français fait 14 chiffres ; les espaces de saisie sont tolérés. */
function normaliseSiret(value: string): { siret: string | null; error?: string } {
  const digits = value.replace(/\s/g, '')
  if (!digits) return { siret: null }
  if (!/^\d{14}$/.test(digits)) {
    return { siret: null, error: 'Le SIRET doit comporter 14 chiffres.' }
  }
  return { siret: digits }
}

function readClient(formData: FormData): { error: string } | { input: Parameters<typeof createClient>[0] } {
  const name = text(formData, 'name')
  if (!name) return { error: 'La raison sociale est obligatoire.' }

  const siret = normaliseSiret(text(formData, 'siret'))
  if (siret.error) return { error: siret.error }

  // Mêmes règles que pour les contacts de la fiche (`contacts-regles.ts`).
  const email = normaliseEmail(text(formData, 'email'))
  if (email && !isValidEmail(email)) {
    return { error: 'Le courriel doit être une adresse valide, comme contact@entreprise.fr.' }
  }
  const phone = normalisePhone(text(formData, 'phone'))
  if (phone.error) return { error: `Téléphone du client. ${phone.error}` }

  const status = text(formData, 'status')

  return {
    input: {
      name,
      legalForm: optional(formData, 'legalForm'),
      siret: siret.siret,
      vatNumber: optional(formData, 'vatNumber'),
      email: email || null,
      phone: phone.phone,
      addressLine1: optional(formData, 'addressLine1'),
      addressLine2: optional(formData, 'addressLine2'),
      postalCode: optional(formData, 'postalCode'),
      city: optional(formData, 'city'),
      country: text(formData, 'country').toUpperCase() || 'FR',
      status: clientStatuses.includes(status as ClientStatus)
        ? (status as ClientStatus)
        : 'prospect',
      notes: optional(formData, 'notes'),
    },
  }
}

export async function createClientAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('clients.gerer')
  const read = readClient(formData)
  if ('error' in read) return read

  let id: string
  try {
    id = (await createClient(read.input)).id
  } catch (error) {
    if (error instanceof DuplicateSiretError) return { error: error.message }
    throw error
  }

  revalidatePath('/clients')
  redirect(`/clients/${id}`)
}

export async function updateClientAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('clients.gerer')
  const id = text(formData, 'id')
  if (!id) return { error: 'Client introuvable.' }

  const read = readClient(formData)
  if ('error' in read) return read

  try {
    await updateClient(id, read.input)
  } catch (error) {
    if (error instanceof DuplicateSiretError) return { error: error.message }
    throw error
  }

  revalidatePath('/clients')
  redirect(`/clients/${id}`)
}

export async function archiveClientAction(formData: FormData): Promise<void> {
  await requirePermission('clients.archiver')
  const id = text(formData, 'id')
  if (!id) return
  await archiveClient(id)
  revalidatePath('/clients')
  redirect('/clients')
}
