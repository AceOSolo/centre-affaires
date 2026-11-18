import { isUuid } from '../../lib/uuid.ts'
import { readForwardAddress, sameForwardAddress, type ForwardAddress } from './demandes-regles.ts'

/**
 * Carnet d'adresses de réexpédition d'une entreprise (ADR 078), sans base ni
 * framework, éprouvé seul (`carnet-adresses-regles.test.ts`).
 *
 * Partagé par les personnes de l'entreprise ; une adresse par défaut au plus,
 * proposée en premier à chaque demande d'envoi. La demande recopie l'adresse
 * et la fige (ADR 037) : le carnet n'est qu'une liste de propositions.
 */

/** Vingt adresses par entreprise : de quoi choisir, pas de quoi tenir un fichier. */
export const MAX_FORWARD_ADDRESSES = 20
export const MAX_ADDRESS_LABEL_LENGTH = 60

/** Une adresse du carnet, telle que l'espace client la montre. */
export type AddressBookEntry = {
  id: string
  clientId: string
  label: string | null
  address: ForwardAddress
  isDefault: boolean
}

/** Ce qu'on enregistre : l'adresse, son nom court, et si elle devient celle par défaut. */
export type AddressBookInput = { label: string | null; address: ForwardAddress; isDefault: boolean }

/** Noms des champs propres au carnet, qui sont aussi leurs `id` (résumé d'erreurs). */
export const addressBookFieldLabels = {
  adresseNom: 'Nom de l’adresse',
} as const

/**
 * Lit une adresse saisie dans le carnet : celles de la réexpédition
 * (`readForwardAddress`), plus un nom court facultatif.
 */
export function readAddressBookInput(
  values: Partial<Record<string, string>>,
): { input: AddressBookInput; fieldErrors?: undefined } | { input?: undefined; fieldErrors: Record<string, string> } {
  const read = readForwardAddress(values)
  const fieldErrors: Record<string, string> = { ...(read.fieldErrors ?? {}) }
  const label = (values.adresseNom ?? '').replace(/\s+/g, ' ').trim()
  if (label.length > MAX_ADDRESS_LABEL_LENGTH) fieldErrors.adresseNom = `${MAX_ADDRESS_LABEL_LENGTH} caractères au plus.`
  if (Object.keys(fieldErrors).length > 0 || !read.address) return { fieldErrors }
  return { input: { label: label || null, address: read.address, isDefault: values.parDefaut === 'on' } }
}

/**
 * Où ranger une nouvelle adresse : refusée au-delà de vingt ou si elle est
 * déjà dans le carnet (à la casse et aux espaces près) ; par défaut si on le
 * demande, ou si c'est la première.
 */
export function placeNewAddress(
  existing: readonly Pick<AddressBookEntry, 'id' | 'address'>[],
  input: AddressBookInput,
  exceptId?: string,
): { isDefault: boolean; error?: undefined } | { isDefault?: undefined; error: string } {
  const others = existing.filter((entry) => entry.id !== exceptId)
  if (exceptId === undefined && others.length >= MAX_FORWARD_ADDRESSES) {
    return { error: `${MAX_FORWARD_ADDRESSES} adresses au plus : retirez-en une avant d’en ajouter une autre.` }
  }
  if (others.some((entry) => sameForwardAddress(entry.address, input.address))) {
    return { error: 'Cette adresse est déjà dans votre carnet.' }
  }
  return { isDefault: input.isDefault || (exceptId === undefined && others.length === 0) }
}

/**
 * L'adresse qui devient celle par défaut quand on retire celle qui l'était :
 * la première restante dans l'ordre du carnet, pour qu'il y en ait toujours
 * une tant que le carnet n'est pas vide.
 */
export function nextDefault(entries: readonly AddressBookEntry[], removedId: string): string | undefined {
  const removed = entries.find((entry) => entry.id === removedId)
  if (!removed?.isDefault) return undefined
  return sortAddressBook(entries.filter((entry) => entry.id !== removedId))[0]?.id
}

/** L'ordre du carnet : l'adresse par défaut, puis par nom court, puis par destinataire. */
export function sortAddressBook<T extends Pick<AddressBookEntry, 'id' | 'label' | 'address' | 'isDefault'>>(
  entries: readonly T[],
): T[] {
  const name = (entry: T) => (entry.label ?? entry.address.recipient).toLocaleLowerCase('fr')
  return [...entries].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || name(a).localeCompare(name(b), 'fr') || a.id.localeCompare(b.id),
  )
}

/**
 * Le choix d'adresse d'une demande d'envoi : une adresse du carnet
 * (`carnet:<id>`), une adresse d'une réexpédition passée (l'identifiant de la
 * demande, ADR 037), ou une autre, saisie.
 */
export type ForwardChoice = { source: 'carnet'; id: string } | { source: 'precedente'; requestId: string } | { source: 'nouvelle' }

export function readForwardChoice(value: string | null | undefined): ForwardChoice {
  const text = (value ?? '').trim()
  if (text.startsWith('carnet:') && isUuid(text.slice('carnet:'.length))) {
    return { source: 'carnet', id: text.slice('carnet:'.length) }
  }
  if (isUuid(text)) return { source: 'precedente', requestId: text }
  return { source: 'nouvelle' }
}

/** Adresse du centre, telle que Configuration la tient (`tenants`). */
export type CentreAddress = {
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
}

/**
 * L'adresse de domiciliation d'une entreprise : sa raison sociale à l'adresse
 * du centre, telle qu'elle l'écrit sur ses papiers. Le pays n'est dit que hors
 * de France. Nulle tant que le centre n'a pas renseigné son adresse.
 */
export function domiciliationLines(companyName: string, centre: CentreAddress, countryName: (code: string) => string): string[] | null {
  const line1 = centre.addressLine1?.trim()
  const postalCode = centre.postalCode?.trim()
  const city = centre.city?.trim()
  if (!line1 || !postalCode || !city) return null
  return [
    companyName,
    line1,
    ...(centre.addressLine2?.trim() ? [centre.addressLine2.trim()] : []),
    `${postalCode} ${city}`,
    ...(centre.country && centre.country !== 'FR' ? [countryName(centre.country)] : []),
  ]
}

/** Nom d'une adresse dans une liste : son nom court, sinon son destinataire et sa ville. */
export function addressTitle(entry: Pick<AddressBookEntry, 'label' | 'address'>): string {
  return entry.label ?? `${entry.address.recipient}, ${entry.address.city}`
}
