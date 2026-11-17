import { and, eq, inArray } from 'drizzle-orm'

import type { Database, Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import {
  nextDefault,
  placeNewAddress,
  sortAddressBook,
  type AddressBookEntry,
  type AddressBookInput,
} from './carnet-adresses-regles.ts'
import { mailForwardAddresses } from './schema-client.ts'

/**
 * Carnet d'adresses de réexpédition des entreprises du compte (ADR 078).
 *
 * Tout passe par `inClientSpace` : la base refuse d'écrire hors des
 * entreprises du compte (`62-courrier-client.sql`), chaque lecture filtre le
 * centre et les entreprises. L'entreprise vient du compte connecté, jamais du
 * formulaire seul.
 */

export type AddressBookResult = { ok: true; id: string } | { ok: false; error: string }

const columns = {
  id: mailForwardAddresses.id,
  clientId: mailForwardAddresses.clientId,
  label: mailForwardAddresses.label,
  recipient: mailForwardAddresses.recipient,
  line1: mailForwardAddresses.line1,
  line2: mailForwardAddresses.line2,
  postalCode: mailForwardAddresses.postalCode,
  city: mailForwardAddresses.city,
  country: mailForwardAddresses.country,
  isDefault: mailForwardAddresses.isDefault,
}

type Row = {
  id: string
  clientId: string
  label: string | null
  recipient: string
  line1: string
  line2: string | null
  postalCode: string
  city: string
  country: string
  isDefault: boolean
}

const toEntry = (row: Row): AddressBookEntry => ({
  id: row.id,
  clientId: row.clientId,
  label: row.label,
  isDefault: Boolean(row.isDefault),
  address: {
    recipient: row.recipient,
    line1: row.line1,
    line2: row.line2,
    postalCode: row.postalCode,
    city: row.city,
    country: row.country,
  },
})

/** Les adresses d'une entreprise, verrouillées : deux onglets qui ajoutent en même temps comptent juste. */
async function lockedBook(tx: Transaction, clientId: string): Promise<AddressBookEntry[]> {
  const rows = await tx
    .select(columns)
    .from(mailForwardAddresses)
    .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.clientId, clientId)))
    .for('update')
  return rows.map(toEntry)
}

const values = (input: AddressBookInput) => ({
  label: input.label,
  recipient: input.address.recipient,
  line1: input.address.line1,
  line2: input.address.line2,
  postalCode: input.address.postalCode,
  city: input.address.city,
  country: input.address.country,
})

/** Retire le « par défaut » des autres adresses, avant d'en désigner une. */
async function clearDefault(tx: Transaction, clientId: string, exceptId?: string) {
  const book = await lockedBook(tx, clientId)
  for (const entry of book) {
    if (entry.isDefault && entry.id !== exceptId) {
      await tx
        .update(mailForwardAddresses)
        .set({ isDefault: false })
        .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.id, entry.id)))
    }
  }
}

/** Le carnet des entreprises du compte (ou de l'une d'elles), l'adresse par défaut d'abord. */
export async function listForwardAddresses(
  accounts: ClientAccount[],
  clientId?: string,
  database?: Database,
): Promise<AddressBookEntry[]> {
  const clientIds = accounts
    .map((account) => account.clientId)
    .filter((candidate) => clientId === undefined || candidate === clientId)
  if (clientIds.length === 0) return []
  const rows = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select(columns)
        .from(mailForwardAddresses)
        .where(
          and(eq(mailForwardAddresses.tenantId, currentTenantId()), inArray(mailForwardAddresses.clientId, clientIds)),
        ),
    database,
  )
  return sortAddressBook(rows.map(toEntry))
}

/** Ajoute une adresse au carnet d'une entreprise du compte. */
export async function createForwardAddress(
  accounts: ClientAccount[],
  clientId: string,
  input: AddressBookInput,
  database?: Database,
): Promise<AddressBookResult> {
  if (!accounts.some((account) => account.clientId === clientId)) {
    return { ok: false, error: 'Entreprise introuvable dans votre espace.' }
  }
  return inClientSpace(
    accounts,
    async (tx) => {
      const book = await lockedBook(tx, clientId)
      const placed = placeNewAddress(book, input)
      if (placed.error !== undefined) return { ok: false as const, error: placed.error }
      if (placed.isDefault) await clearDefault(tx, clientId)
      const id = uuidv7()
      await tx.insert(mailForwardAddresses).values({ id, clientId, ...values(input), isDefault: placed.isDefault })
      return { ok: true as const, id }
    },
    database,
  )
}

/** L'adresse, si elle est au carnet d'une entreprise du compte. */
async function findOwned(tx: Transaction, accounts: ClientAccount[], id: string) {
  if (!isUuid(id)) return undefined
  const [row] = await tx
    .select(columns)
    .from(mailForwardAddresses)
    .where(
      and(
        eq(mailForwardAddresses.tenantId, currentTenantId()),
        eq(mailForwardAddresses.id, id),
        inArray(
          mailForwardAddresses.clientId,
          accounts.map((account) => account.clientId),
        ),
      ),
    )
  return row ? toEntry(row) : undefined
}

/** Modifie une adresse du carnet ; les demandes déjà déposées gardent la leur (ADR 037). */
export async function updateForwardAddress(
  accounts: ClientAccount[],
  id: string,
  input: AddressBookInput,
  database?: Database,
): Promise<AddressBookResult> {
  if (accounts.length === 0) return { ok: false, error: 'Adresse introuvable.' }
  return inClientSpace(
    accounts,
    async (tx) => {
      const found = await findOwned(tx, accounts, id)
      if (!found) return { ok: false as const, error: 'Cette adresse n’est plus dans votre carnet.' }
      const book = await lockedBook(tx, found.clientId)
      const placed = placeNewAddress(book, input, id)
      if (placed.error !== undefined) return { ok: false as const, error: placed.error }
      // Décocher « par défaut » ne retire pas ce rôle : on le donne à une autre adresse.
      const isDefault = found.isDefault || placed.isDefault
      if (isDefault && !found.isDefault) await clearDefault(tx, found.clientId, id)
      await tx
        .update(mailForwardAddresses)
        .set({ ...values(input), isDefault })
        .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.id, id)))
      return { ok: true as const, id }
    },
    database,
  )
}

/** Fait d'une adresse du carnet celle proposée en premier. */
export async function setDefaultForwardAddress(
  accounts: ClientAccount[],
  id: string,
  database?: Database,
): Promise<AddressBookResult> {
  if (accounts.length === 0) return { ok: false, error: 'Adresse introuvable.' }
  return inClientSpace(
    accounts,
    async (tx) => {
      const found = await findOwned(tx, accounts, id)
      if (!found) return { ok: false as const, error: 'Cette adresse n’est plus dans votre carnet.' }
      await clearDefault(tx, found.clientId, id)
      await tx
        .update(mailForwardAddresses)
        .set({ isDefault: true })
        .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.id, id)))
      return { ok: true as const, id }
    },
    database,
  )
}

/**
 * Retire une adresse du carnet. Réglage de l'entreprise : rien n'en reste, les
 * demandes déposées gardent leur adresse figée. Celle par défaut retirée, la
 * première restante le devient.
 */
export async function deleteForwardAddress(
  accounts: ClientAccount[],
  id: string,
  database?: Database,
): Promise<AddressBookResult> {
  if (accounts.length === 0) return { ok: false, error: 'Adresse introuvable.' }
  return inClientSpace(
    accounts,
    async (tx) => {
      const found = await findOwned(tx, accounts, id)
      if (!found) return { ok: false as const, error: 'Cette adresse n’est plus dans votre carnet.' }
      const book = await lockedBook(tx, found.clientId)
      const promoted = nextDefault(book, id)
      await tx
        .delete(mailForwardAddresses)
        .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.id, id)))
      if (promoted) {
        await tx
          .update(mailForwardAddresses)
          .set({ isDefault: true })
          .where(and(eq(mailForwardAddresses.tenantId, currentTenantId()), eq(mailForwardAddresses.id, promoted)))
      }
      return { ok: true as const, id }
    },
    database,
  )
}
