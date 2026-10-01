import { randomBytes } from 'node:crypto'

import { and, desc, eq, isNull } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgConstraintName, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants, type PaymentMethod } from '../../db/tenants.ts'
import { DocumentKeyError, documentKeyringFromEnv } from '../../lib/chiffrement-documents.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import { sealIban } from './iban.ts'
import { generateMandateReference, isMandateLapsed, type MandateInput } from './mandats-regles.ts'
import { sepaMandates, type SepaMandate } from './schema-factures.ts'

/**
 * Mandats de prélèvement SEPA d'un client (R16, ADR 027, ADR 028).
 *
 * L'IBAN est chiffré avant l'écriture (`sealIban`) et ne ressort jamais de ce
 * module en clair : les listes ne lisent pas même le chiffré, seulement les
 * quatre derniers caractères. Seul le fichier de remise à la banque le
 * déchiffre (`prelevements.ts`).
 */

/** Ce que l'écran montre d'un mandat : jamais l'IBAN, ni même son chiffré. */
export type MandateRow = Omit<SepaMandate, 'ibanCiphertext' | 'ibanKeyVersion'> & {
  /** Caduc de fait : 36 mois sans prélèvement, même si le statut n'a pas encore suivi. */
  lapsed: boolean
}

const listedColumns = {
  id: sepaMandates.id,
  tenantId: sepaMandates.tenantId,
  clientId: sepaMandates.clientId,
  reference: sepaMandates.reference,
  debtorName: sepaMandates.debtorName,
  ibanLast4: sepaMandates.ibanLast4,
  bic: sepaMandates.bic,
  signedOn: sepaMandates.signedOn,
  sequenceType: sepaMandates.sequenceType,
  status: sepaMandates.status,
  revokedOn: sepaMandates.revokedOn,
  lastCollectedOn: sepaMandates.lastCollectedOn,
  createdAt: sepaMandates.createdAt,
  updatedAt: sepaMandates.updatedAt,
  deletedAt: sepaMandates.deletedAt,
}

/** Mandats d'un client, le plus récent d'abord. */
export async function listClientMandates(clientId: string, today: string): Promise<MandateRow[]> {
  if (!isUuid(clientId)) return []
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(listedColumns)
      .from(sepaMandates)
      .where(and(eq(sepaMandates.clientId, clientId), isNull(sepaMandates.deletedAt)))
      .orderBy(desc(sepaMandates.signedOn), desc(sepaMandates.createdAt)),
  )
  return rows.map((row) => ({
    ...row,
    lapsed: row.status === 'active' && isMandateLapsed(row, today),
  }))
}

/** La clé des documents est-elle configurée ? Sans elle, aucun mandat ne s'enregistre (ADR 020). */
export function mandateEncryptionReady(): boolean {
  try {
    documentKeyringFromEnv()
    return true
  } catch (error) {
    if (error instanceof DocumentKeyError) return false
    throw error
  }
}

/** Le client a déjà un mandat actif : un seul à la fois (ADR 027). */
export class ActiveMandateExistsError extends Error {
  constructor() {
    super('Ce client a déjà un mandat actif : révoquez-le avant d’en enregistrer un nouveau.')
    this.name = 'ActiveMandateExistsError'
  }
}

/** Fiche archivée ou introuvable : pas de nouveau mandat. */
export class MandateClientUnavailableError extends Error {
  constructor() {
    super('Cette fiche client est archivée ou introuvable : aucun mandat ne s’y enregistre.')
    this.name = 'MandateClientUnavailableError'
  }
}

/** Tirages de RUM avant d'abandonner : une collision est déjà improbable. */
const REFERENCE_ATTEMPTS = 5

/**
 * Enregistre un mandat signé : RUM générée, IBAN chiffré et lié à elle, quatre
 * derniers caractères en clair pour l'affichage. Lève `DocumentKeyError` si la
 * clé des documents manque, `ActiveMandateExistsError` si le client a déjà un
 * mandat actif.
 */
export async function createMandate(
  clientId: string,
  input: MandateInput,
  today: string,
): Promise<{ id: string; reference: string }> {
  const tenantId = currentTenantId()
  for (let attempt = 1; ; attempt++) {
    const reference = generateMandateReference(today, randomBytes(6))
    // Chiffré pour cette RUM : un chiffré recopié sur un autre mandat ne se lit pas.
    const sealed = sealIban(input.iban, { tenantId, reference })
    try {
      return await withTenant(tenantId, async (tx) => {
        const [client] = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
          .for('share')
        if (!client) throw new MandateClientUnavailableError()
        const [created] = await tx
          .insert(sepaMandates)
          .values({
            clientId,
            reference,
            debtorName: input.debtorName,
            ibanCiphertext: sealed.ciphertext,
            ibanKeyVersion: sealed.keyVersion,
            ibanLast4: sealed.last4,
            bic: input.bic,
            signedOn: input.signedOn,
            sequenceType: input.sequenceType,
          })
          .returning({ id: sepaMandates.id, reference: sepaMandates.reference })
        return created
      })
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const constraint = pgConstraintName(error)
        if (constraint === 'sepa_mandates_one_active_key') throw new ActiveMandateExistsError()
        if (constraint === 'sepa_mandates_tenant_reference_key' && attempt < REFERENCE_ATTEMPTS) continue
      }
      throw error
    }
  }
}

/**
 * Mode de paiement d'une nouvelle facture d'un client, pour qui crée le
 * brouillon (lot de facturation, facture manuelle) : le prélèvement sur son
 * mandat actif et non caduc, sinon le mode par défaut du centre — le virement,
 * si celui-ci est le prélèvement sans mandat. Dans la transaction appelante.
 */
export async function invoicePaymentSetup(
  tx: Transaction,
  clientId: string,
  today: string,
): Promise<{ expectedPaymentMethod: PaymentMethod; sepaMandateId: string | null }> {
  const [mandate] = await tx
    .select({
      id: sepaMandates.id,
      signedOn: sepaMandates.signedOn,
      lastCollectedOn: sepaMandates.lastCollectedOn,
    })
    .from(sepaMandates)
    .where(
      and(
        eq(sepaMandates.clientId, clientId),
        eq(sepaMandates.status, 'active'),
        isNull(sepaMandates.deletedAt),
      ),
    )
    .limit(1)
  if (mandate && !isMandateLapsed(mandate, today)) {
    return { expectedPaymentMethod: 'direct_debit', sepaMandateId: mandate.id }
  }
  const [tenant] = await tx
    .select({ defaultPaymentMethod: tenants.defaultPaymentMethod })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  const method = tenant?.defaultPaymentMethod ?? 'transfer'
  return { expectedPaymentMethod: method === 'direct_debit' ? 'transfer' : method, sepaMandateId: null }
}

/**
 * Révoque un mandat actif au jour donné (jour du centre). Les factures déjà
 * émises sur ce mandat ne se prélèvent plus : l'écran des prélèvements les
 * montre bloquées. Rend `false` s'il n'y avait rien à révoquer.
 */
export async function revokeMandate(clientId: string, mandateId: string, today: string): Promise<boolean> {
  if (!isUuid(clientId) || !isUuid(mandateId)) return false
  const revoked = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(sepaMandates)
      .set({ status: 'revoked', revokedOn: today })
      .where(
        and(
          eq(sepaMandates.id, mandateId),
          eq(sepaMandates.clientId, clientId),
          eq(sepaMandates.status, 'active'),
          isNull(sepaMandates.deletedAt),
        ),
      )
      .returning({ id: sepaMandates.id }),
  )
  return revoked.length > 0
}
