'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireClientAccount } from '../clients/session.ts'
import {
  createForwardAddress,
  deleteForwardAddress,
  setDefaultForwardAddress,
  updateForwardAddress,
} from './carnet-adresses.ts'
import { addressBookFieldLabels, readAddressBookInput } from './carnet-adresses-regles.ts'
import { forwardAddressFieldLabels } from './demandes-regles.ts'

/**
 * Carnet d'adresses de réexpédition, depuis l'espace client (ADR 078). Chaque
 * action revérifie le compte : une action serveur s'invoque par son
 * identifiant depuis n'importe quelle page (ADR 008).
 */
export type AddressBookFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Valeurs saisies, rendues au formulaire : React le réinitialise après l'envoi. */
  values?: Record<string, string>
} | null

const PAGE = '/compte/courrier/adresses'

const fields = [...Object.keys(forwardAddressFieldLabels), ...Object.keys(addressBookFieldLabels), 'parDefaut']

function readValues(formData: FormData): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, String(formData.get(field) ?? '')]))
}

function refresh() {
  revalidatePath(PAGE)
  // Le formulaire d'envoi de chaque pli propose le carnet.
  revalidatePath('/compte/courrier', 'layout')
}

/** Nouvelle adresse ; `entreprise` quand le compte en a plusieurs. */
export async function createAddressAction(
  _previous: AddressBookFormState,
  formData: FormData,
): Promise<AddressBookFormState> {
  const { accounts } = await requireClientAccount()
  const values = readValues(formData)
  const read = readAddressBookInput(values)
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values }
  const clientId = String(formData.get('entreprise') ?? accounts[0]?.clientId ?? '')
  const result = await createForwardAddress(accounts, clientId, read.input)
  if (!result.ok) return { error: result.error, values }
  refresh()
  redirect(`${PAGE}?fait=ajoutee`)
}

/** Modifier une adresse du carnet. */
export async function updateAddressAction(
  _previous: AddressBookFormState,
  formData: FormData,
): Promise<AddressBookFormState> {
  const { accounts } = await requireClientAccount()
  const values = readValues(formData)
  const read = readAddressBookInput(values)
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values }
  const result = await updateForwardAddress(accounts, String(formData.get('id') ?? ''), read.input)
  if (!result.ok) return { error: result.error, values }
  refresh()
  redirect(`${PAGE}?fait=modifiee`)
}

/** « Utiliser par défaut » : l'adresse proposée en premier à chaque envoi. */
export async function setDefaultAddressAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const result = await setDefaultForwardAddress(accounts, String(formData.get('id') ?? ''))
  refresh()
  redirect(result.ok ? `${PAGE}?fait=par-defaut` : PAGE)
}

/** Retirer une adresse, après confirmation sur la page. */
export async function deleteAddressAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const result = await deleteForwardAddress(accounts, String(formData.get('id') ?? ''))
  refresh()
  redirect(result.ok ? `${PAGE}?fait=retiree` : PAGE)
}
