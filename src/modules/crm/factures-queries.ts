import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clients } from '../clients/schema.ts'
import type { CrmConnectorId } from './connecteurs.ts'
import { readEnabledFlows } from './flux.ts'
import { sameInvoiceFields, type ReceivedInvoice, type ReceivedInvoiceFields } from './factures.ts'
import { crmInvoices, type CrmInvoiceKind, type CrmInvoiceStatus } from './schema-factures.ts'
import { crmConnections } from './schema.ts'
import { crmLinks } from './schema-liens.ts'

/**
 * Factures reçues du CRM, en base (ADR 081) : l'envoi du CRM, une transaction
 * par facture, et la liste de l'espace client.
 *
 * Tout se lit et s'écrit pour le centre courant (`currentTenantId()`) — celui
 * du jeton, sous `serveCrmCall` — et chaque requête porte son filtre
 * `tenant_id` : MySQL ne filtre pas les lectures (décision 1). La liste de
 * l'espace client filtre en plus sur les entreprises du compte (ADR 019).
 */

export type CrmInvoiceOutcome =
  | {
      result: 'cree' | 'modifie' | 'inchange' | 'retire' | 'ignore'
      invoiceId: string | null
      message: string
    }
  | { result: 'refuse'; status: 409; message: string }

const fieldColumns = {
  number: crmInvoices.number,
  kind: crmInvoices.kind,
  status: crmInvoices.status,
  issuedOn: crmInvoices.issuedOn,
  dueOn: crmInvoices.dueOn,
  totalExclTaxCents: crmInvoices.totalExclTaxCents,
  totalInclTaxCents: crmInvoices.totalInclTaxCents,
  amountDueCents: crmInvoices.amountDueCents,
  currency: crmInvoices.currency,
  pdfUrl: crmInvoices.pdfUrl,
}

async function receiveIn(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  input: ReceivedInvoice,
): Promise<CrmInvoiceOutcome> {
  const [existing] = await tx
    .select({ id: crmInvoices.id, clientId: crmInvoices.clientId, removedAt: crmInvoices.removedAt, ...fieldColumns })
    .from(crmInvoices)
    .where(
      and(
        eq(crmInvoices.tenantId, tenantId),
        eq(crmInvoices.connector, connector),
        eq(crmInvoices.externalId, input.crmId),
      ),
    )
    .for('update')

  if (input.removed) {
    if (!existing) return { result: 'ignore', invoiceId: null, message: 'Facture inconnue du site : rien à retirer.' }
    if (existing.removedAt) {
      return { result: 'inchange', invoiceId: existing.id, message: 'Facture déjà retirée de l’espace client.' }
    }
    await tx
      .update(crmInvoices)
      .set({ removedAt: sql`CURRENT_TIMESTAMP(3)`, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmInvoices.tenantId, tenantId), eq(crmInvoices.id, existing.id)))
    return { result: 'retire', invoiceId: existing.id, message: 'Facture retirée de l’espace client.' }
  }

  // L'entreprise de la facture : le tiers déjà reçu (ADR 066).
  const [owner] = await tx
    .select({ clientId: clients.id })
    .from(crmLinks)
    .innerJoin(clients, and(eq(clients.tenantId, crmLinks.tenantId), eq(clients.id, crmLinks.localId)))
    .where(
      and(
        eq(crmLinks.tenantId, tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'client'),
        eq(crmLinks.externalId, input.thirdPartyCrmId),
        isNull(crmLinks.removedAt),
      ),
    )
  if (!owner) {
    return {
      result: 'refuse',
      status: 409,
      message: `Tiers ${input.thirdPartyCrmId} inconnu du site : l’envoyer d’abord (POST /api/dolibarr/tiers), puis renvoyer la facture.`,
    }
  }

  if (!existing) {
    const id = uuidv7()
    await tx.insert(crmInvoices).values({
      id,
      tenantId,
      connector,
      externalId: input.crmId,
      clientId: owner.clientId,
      ...input.fields,
    })
    return { result: 'cree', invoiceId: id, message: 'Facture reçue : visible dans l’espace client de l’entreprise.' }
  }

  const kept: ReceivedInvoiceFields = {
    number: existing.number,
    kind: existing.kind,
    status: existing.status,
    issuedOn: existing.issuedOn,
    dueOn: existing.dueOn,
    totalExclTaxCents: existing.totalExclTaxCents,
    totalInclTaxCents: existing.totalInclTaxCents,
    amountDueCents: existing.amountDueCents,
    currency: existing.currency,
    pdfUrl: existing.pdfUrl,
  }
  if (!existing.removedAt && existing.clientId === owner.clientId && sameInvoiceFields(kept, input.fields)) {
    return { result: 'inchange', invoiceId: existing.id, message: 'Facture inchangée.' }
  }
  await tx
    .update(crmInvoices)
    .set({ ...input.fields, clientId: owner.clientId, removedAt: null, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
    .where(and(eq(crmInvoices.tenantId, tenantId), eq(crmInvoices.id, existing.id)))
  return {
    result: 'modifie',
    invoiceId: existing.id,
    message: existing.removedAt
      ? 'Facture de nouveau visible dans l’espace client.'
      : 'Facture mise à jour dans l’espace client.',
  }
}

/**
 * Reçoit une facture du CRM : la crée, la met à jour, la retire de l'espace
 * client ou la laisse telle quelle. Rejouable : le même envoi répond
 * « inchange ». Deux envois simultanés de la même facture nouvelle : le
 * second retrouve la ligne du premier (index unique), une seule reprise.
 */
export async function receiveCrmInvoice(connector: CrmConnectorId, input: ReceivedInvoice): Promise<CrmInvoiceOutcome> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, (tx) => receiveIn(tx, tenantId, connector, input))
  } catch (error) {
    if (dbErrorCode(error) !== DB_UNIQUE_VIOLATION) throw error
    return withTenant(tenantId, (tx) => receiveIn(tx, tenantId, connector, input))
  }
}

/* ------------------------------------------------------------------------ */
/* L'espace client                                                          */
/* ------------------------------------------------------------------------ */

/** Factures montrées dans l'espace client : les plus récentes ; Dolibarr garde les autres. */
export const CLIENT_RECEIVED_INVOICE_LIMIT = 60

export type ClientReceivedInvoice = {
  id: string
  clientId: string
  clientName: string
  number: string
  kind: CrmInvoiceKind
  status: CrmInvoiceStatus
  issuedOn: string
  dueOn: string | null
  totalExclTaxCents: number
  totalInclTaxCents: number
  amountDueCents: number | null
  currency: string
  pdfUrl: string | null
}

/**
 * Les factures reçues des entreprises du compte, de la plus récente à la plus
 * ancienne. Jamais une facture retirée (supprimée dans le CRM ou repassée en
 * brouillon), jamais celle d'une autre entreprise.
 */
export async function listReceivedInvoicesForAccounts(
  accounts: readonly ClientAccount[],
  limit = CLIENT_RECEIVED_INVOICE_LIMIT,
): Promise<ClientReceivedInvoice[]> {
  if (accounts.length === 0) return []
  const clientIds = accounts.map((account) => account.clientId)
  const tenantId = currentTenantId()
  return inClientSpace(accounts, (tx) =>
    tx
      .select({
        id: crmInvoices.id,
        clientId: crmInvoices.clientId,
        clientName: clients.name,
        ...fieldColumns,
      })
      .from(crmInvoices)
      .innerJoin(clients, and(eq(clients.tenantId, crmInvoices.tenantId), eq(clients.id, crmInvoices.clientId)))
      .where(
        and(
          eq(crmInvoices.tenantId, tenantId),
          inArray(crmInvoices.clientId, clientIds),
          isNull(crmInvoices.removedAt),
        ),
      )
      .orderBy(desc(crmInvoices.issuedOn), desc(crmInvoices.number), desc(crmInvoices.id))
      .limit(limit),
  )
}

/**
 * Le flux « Factures » est-il ouvert pour le centre ? Fermé, l'espace client
 * dit que les factures arrivent par courriel plutôt qu'une liste vide.
 */
export async function invoicesFlowEnabled(): Promise<boolean> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ enabledFlows: crmConnections.enabledFlows })
      .from(crmConnections)
      .where(eq(crmConnections.tenantId, tenantId))
      .limit(1),
  )
  return readEnabledFlows(row?.enabledFlows).includes('invoices')
}
