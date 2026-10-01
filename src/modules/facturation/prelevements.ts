import { randomBytes } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import {
  DocumentIntegrityError,
  DocumentKeyError,
} from '../../lib/chiffrement-documents.ts'
import { toWallClock } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { openIban } from './iban.ts'
import {
  directDebitBlocker,
  generateRemittanceId,
  isRemittanceId,
  sepaSequenceFor,
} from './mandats-regles.ts'
import { amountDueCents } from './montants.ts'
import {
  invoices,
  payments,
  sepaMandates,
  type SepaMandateStatus,
  type SepaSequenceType,
} from './schema-factures.ts'
import { SepaExportError, buildPain008, type SepaDirectDebit, type SepaRemittance } from './sepa-xml.ts'

/**
 * Remises de prélèvements SEPA (R16, ADR 027, ADR 028).
 *
 * Préparer une remise, c'est choisir les factures échues payables par
 * prélèvement et **les marquer** : chacune reçoit un paiement `direct_debit`
 * du reste dû, daté du jour de prélèvement demandé, dont la référence est
 * l'identifiant de la remise. La facture passe « réglée » ; un rejet de la
 * banque s'annule comme toute erreur de pointage (motif : rejet), et la
 * facture redevient à régler — et prélevable.
 *
 * Le fichier `pain.008` n'est pas stocké : il contient les IBAN des débiteurs
 * en clair. Il se reconstruit à l'identique depuis les paiements de la remise,
 * à chaque téléchargement.
 */

/** Remise impossible : la liste dit quoi régler avant de recommencer. */
export class RemittanceError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(problems.join(' ; '))
    this.name = 'RemittanceError'
    this.problems = problems
  }
}

export type DirectDebitCandidate = {
  invoiceId: string
  number: string
  clientId: string
  clientName: string
  dueDate: string
  currency: string
  amountDueCents: number
  mandate: {
    reference: string
    status: SepaMandateStatus
    sequenceType: SepaSequenceType
    ibanLast4: string
  } | null
  /** Pourquoi la facture ne peut pas être prélevée ; nul : elle le peut. */
  blocker: string | null
}

/** Un mandat a-t-il déjà servi à un prélèvement non annulé ? */
const mandateUsed = sql<boolean>`exists (
  select 1 from payments as q
   where q.tenant_id = ${sepaMandates.tenantId}
     and q.sepa_mandate_id = ${sepaMandates.id}
     and q.method = 'direct_debit'
     and q.cancelled_at is null
)`

const candidateColumns = {
  invoiceId: invoices.id,
  number: invoices.number,
  clientId: invoices.clientId,
  clientName: clients.name,
  dueDate: invoices.dueDate,
  currency: invoices.currency,
  totalInclTaxCents: invoices.totalInclTaxCents,
  paidCents: invoices.paidCents,
  creditedCents: invoices.creditedCents,
  mandateId: sepaMandates.id,
  mandateReference: sepaMandates.reference,
  mandateStatus: sepaMandates.status,
  mandateDeletedAt: sepaMandates.deletedAt,
  mandateSequenceType: sepaMandates.sequenceType,
  mandateSignedOn: sepaMandates.signedOn,
  mandateLastCollectedOn: sepaMandates.lastCollectedOn,
  mandateIbanLast4: sepaMandates.ibanLast4,
  mandateUsed,
}

/** Factures émises payables par prélèvement, échues au jour demandé, qui restent dues. */
function candidatesQuery(tx: Transaction, collectionDate: string, invoiceIds?: readonly string[]) {
  return tx
    .select(candidateColumns)
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(sepaMandates, eq(sepaMandates.id, invoices.sepaMandateId))
    .where(
      and(
        eq(invoices.kind, 'invoice'),
        eq(invoices.expectedPaymentMethod, 'direct_debit'),
        inArray(invoices.status, ['issued', 'partially_paid']),
        isNull(invoices.deletedAt),
        lte(invoices.dueDate, collectionDate),
        sql`${invoices.totalInclTaxCents} - ${invoices.creditedCents} - ${invoices.paidCents} > 0`,
        invoiceIds ? inArray(invoices.id, [...invoiceIds]) : undefined,
      ),
    )
}

type CandidateRow = Awaited<ReturnType<typeof candidatesQuery>>[number]

function toCandidate(row: CandidateRow, today: string): DirectDebitCandidate {
  const mandate =
    row.mandateId && row.mandateStatus && row.mandateSequenceType && row.mandateSignedOn
      ? {
          status: row.mandateStatus,
          deleted: row.mandateDeletedAt !== null,
          sequenceType: row.mandateSequenceType,
          signedOn: row.mandateSignedOn,
          lastCollectedOn: row.mandateLastCollectedOn,
          usedOnce: Boolean(row.mandateUsed),
        }
      : null
  return {
    invoiceId: row.invoiceId,
    number: row.number ?? '',
    clientId: row.clientId,
    clientName: row.clientName,
    dueDate: row.dueDate ?? '',
    currency: row.currency,
    amountDueCents: amountDueCents(row),
    mandate:
      mandate && row.mandateReference && row.mandateIbanLast4
        ? {
            reference: row.mandateReference,
            status: mandate.status,
            sequenceType: mandate.sequenceType,
            ibanLast4: row.mandateIbanLast4,
          }
        : null,
    blocker: directDebitBlocker({ currency: row.currency, mandate }, today),
  }
}

/** Factures à prélever au jour `collectionDate`, l'échéance la plus ancienne d'abord. */
export async function listDirectDebitCandidates({
  collectionDate,
  today,
}: {
  collectionDate: string
  today: string
}): Promise<DirectDebitCandidate[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    candidatesQuery(tx, collectionDate).orderBy(asc(invoices.dueDate), asc(invoices.number)),
  )
  return rows.map((row) => toCandidate(row, today))
}

type Creditor = SepaRemittance['creditor']

async function loadCreditor(tx: Transaction): Promise<{ creditor: Creditor; timeZone: string }> {
  const [tenant] = await tx
    .select({
      name: tenants.name,
      legalName: tenants.legalName,
      bankIban: tenants.bankIban,
      bankBic: tenants.bankBic,
      sepaCreditorId: tenants.sepaCreditorId,
      timezone: tenants.timezone,
    })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  const problems: string[] = []
  if (!tenant?.sepaCreditorId) problems.push('l’identifiant créancier SEPA (ICS) du centre n’est pas renseigné')
  if (!tenant?.bankIban) problems.push('l’IBAN du centre n’est pas renseigné')
  if (problems.length > 0) throw new RemittanceError(problems)
  return {
    creditor: {
      name: tenant.legalName ?? tenant.name,
      iban: tenant.bankIban as string,
      bic: tenant.bankBic,
      creditorId: tenant.sepaCreditorId as string,
    },
    timeZone: tenant.timezone,
  }
}

/** IBAN d'un mandat, déchiffré pour le seul fichier ; une clé absente ou un chiffré altéré arrêtent tout. */
function debtorIban(mandate: { ibanCiphertext: Buffer; ibanKeyVersion: number; reference: string }): string {
  try {
    return openIban(mandate.ibanCiphertext, mandate.ibanKeyVersion, {
      tenantId: currentTenantId(),
      reference: mandate.reference,
    })
  } catch (error) {
    if (error instanceof DocumentKeyError) {
      throw new RemittanceError([
        'le chiffrement des documents n’est pas configuré sur ce serveur : les IBAN des mandats ne peuvent pas être relus',
      ])
    }
    if (error instanceof DocumentIntegrityError) {
      throw new RemittanceError([`mandat ${mandate.reference} : IBAN illisible, faites ressaisir le mandat`])
    }
    throw error
  }
}

/** « 2026-10-01T09:30:12 » : heure murale du centre, à la seconde. */
function wallClockSeconds(instant: Date, timeZone: string): string {
  // Les décalages de fuseau sont des minutes entières : les secondes ne changent pas.
  return `${toWallClock(instant, timeZone)}:${String(instant.getUTCSeconds()).padStart(2, '0')}`
}

/**
 * Prépare une remise : vérifie chaque facture (échue, due, mandat utilisable),
 * vérifie que le fichier se construit — IBAN lisibles, données au format
 * SEPA —, puis marque les factures d'un paiement `direct_debit` du reste dû,
 * daté du jour de prélèvement, et date le dernier prélèvement des mandats.
 * Tout ou rien.
 */
export async function prepareDirectDebitRemittance({
  invoiceIds,
  collectionDate,
  today,
  recordedBy,
}: {
  invoiceIds: readonly string[]
  collectionDate: string
  today: string
  recordedBy: string
}): Promise<{ remittanceId: string; count: number; totalCents: number }> {
  const ids = [...new Set(invoiceIds)]
  if (ids.length === 0) throw new RemittanceError(['choisissez au moins une facture'])

  return withTenant(currentTenantId(), async (tx) => {
    const { creditor, timeZone } = await loadCreditor(tx)
    // Deux remises simultanées ne prélèvent pas deux fois la même facture :
    // les factures choisies restent verrouillées jusqu'à la fin.
    const locked = await tx
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .where(inArray(invoices.id, ids))
      .orderBy(asc(invoices.id))
      .for('no key update')
    const rows = await candidatesQuery(tx, collectionDate, ids).orderBy(asc(invoices.number))

    const problems: string[] = []
    if (locked.length !== ids.length) problems.push('une facture choisie est introuvable')
    const eligible = new Set(rows.map((row) => row.invoiceId))
    for (const invoice of locked) {
      if (!eligible.has(invoice.id)) {
        problems.push(
          `${invoice.number ?? 'brouillon'} : n’est pas à prélever (déjà réglée, pas échue au ${collectionDate}, ou pas payable par prélèvement)`,
        )
      }
    }
    const candidates = rows.map((row) => toCandidate(row, today))
    for (const candidate of candidates) {
      if (candidate.blocker) problems.push(`${candidate.number} : ${candidate.blocker}`)
    }
    if (problems.length > 0) throw new RemittanceError(problems)

    const mandateIds = [...new Set(rows.map((row) => row.mandateId as string))]
    const secrets = await tx
      .select({
        id: sepaMandates.id,
        reference: sepaMandates.reference,
        debtorName: sepaMandates.debtorName,
        bic: sepaMandates.bic,
        ibanCiphertext: sepaMandates.ibanCiphertext,
        ibanKeyVersion: sepaMandates.ibanKeyVersion,
      })
      .from(sepaMandates)
      .where(inArray(sepaMandates.id, mandateIds))
    const mandates = new Map(secrets.map((mandate) => [mandate.id, mandate]))

    const remittanceId = generateRemittanceId(today, randomBytes(6))
    const transactions: SepaDirectDebit[] = rows.map((row, index) => {
      const mandate = mandates.get(row.mandateId as string)
      if (!mandate || !row.mandateSequenceType || !row.mandateSignedOn) {
        throw new RemittanceError([`${candidates[index].number} : mandat introuvable`])
      }
      return {
        endToEndId: candidates[index].number,
        amountCents: candidates[index].amountDueCents,
        mandateReference: mandate.reference,
        mandateSignedOn: row.mandateSignedOn,
        sequenceType: sepaSequenceFor(row.mandateSequenceType, Boolean(row.mandateUsed)),
        debtorName: mandate.debtorName,
        debtorIban: debtorIban(mandate),
        debtorBic: mandate.bic,
        remittanceInformation: `Facture ${candidates[index].number}`,
      }
    })
    // Le fichier doit se construire avant que rien ne soit marqué.
    try {
      buildPain008({
        messageId: remittanceId,
        createdAt: wallClockSeconds(new Date(), timeZone),
        requestedCollectionDate: collectionDate,
        creditor,
        transactions,
      })
    } catch (error) {
      if (error instanceof SepaExportError) throw new RemittanceError(error.problems)
      throw error
    }

    await tx.insert(payments).values(
      candidates.map((candidate, index) => ({
        invoiceId: candidate.invoiceId,
        amountCents: candidate.amountDueCents,
        currency: candidate.currency,
        paidOn: collectionDate,
        method: 'direct_debit' as const,
        reference: remittanceId,
        sepaMandateId: rows[index].mandateId,
        notes: `Remise de prélèvement ${remittanceId}`,
        recordedBy,
      })),
    )
    await tx
      .update(sepaMandates)
      .set({ lastCollectedOn: sql`greatest(coalesce(${sepaMandates.lastCollectedOn}, ${collectionDate}::date), ${collectionDate}::date)` })
      .where(inArray(sepaMandates.id, mandateIds))

    return {
      remittanceId,
      count: transactions.length,
      totalCents: transactions.reduce((total, transaction) => total + transaction.amountCents, 0),
    }
  })
}

export type RemittanceSummary = {
  remittanceId: string
  collectionDate: string
  createdAt: Date
  /** Prélèvements en vigueur : ceux qu'un rejet n'a pas annulés. */
  activeCount: number
  cancelledCount: number
  activeTotalCents: number
}

/** Remises préparées, la plus récente d'abord. */
export async function listRemittances(limit = 24): Promise<RemittanceSummary[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        remittanceId: payments.reference,
        collectionDate: sql<string>`min(${payments.paidOn})`,
        createdAt: sql<Date>`min(${payments.createdAt})`,
        activeCount: sql<number>`(count(*) filter (where ${payments.cancelledAt} is null))::integer`,
        cancelledCount: sql<number>`(count(*) filter (where ${payments.cancelledAt} is not null))::integer`,
        activeTotalCents: sql<number>`coalesce(sum(${payments.amountCents}) filter (where ${payments.cancelledAt} is null), 0)::integer`,
      })
      .from(payments)
      .where(and(eq(payments.method, 'direct_debit'), sql`${payments.reference} like 'PRLV-%'`))
      .groupBy(payments.reference)
      .orderBy(desc(sql`min(${payments.createdAt})`))
      .limit(limit),
  )
  return rows.map((row) => ({
    ...row,
    remittanceId: row.remittanceId as string,
    createdAt: new Date(row.createdAt),
  }))
}

/**
 * Fichier `pain.008` d'une remise, reconstruit depuis ses paiements non
 * annulés : mêmes montants, même date, même identifiant. Le type de séquence
 * d'un mandat (`FRST`, `RCUR`) se lit dans les remises antérieures, pour que
 * le fichier ne change pas d'un téléchargement à l'autre. `undefined` si la
 * remise est inconnue.
 */
export async function buildRemittanceFile(
  remittanceId: string,
): Promise<{ fileName: string; xml: string; count: number; totalCents: number } | undefined> {
  if (!isRemittanceId(remittanceId)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const rows = await tx
      .select({
        paidOn: payments.paidOn,
        createdAt: payments.createdAt,
        amountCents: payments.amountCents,
        currency: payments.currency,
        number: invoices.number,
        mandateReference: sepaMandates.reference,
        mandateSignedOn: sepaMandates.signedOn,
        sequenceType: sepaMandates.sequenceType,
        debtorName: sepaMandates.debtorName,
        bic: sepaMandates.bic,
        ibanCiphertext: sepaMandates.ibanCiphertext,
        ibanKeyVersion: sepaMandates.ibanKeyVersion,
        collectedBefore: sql<boolean>`exists (
          select 1 from payments as q
           where q.tenant_id = ${payments.tenantId}
             and q.sepa_mandate_id = ${payments.sepaMandateId}
             and q.method = 'direct_debit'
             and q.cancelled_at is null
             and q.created_at < ${payments.createdAt}
             and q.reference is distinct from ${payments.reference}
        )`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(sepaMandates, eq(sepaMandates.id, payments.sepaMandateId))
      .where(
        and(
          eq(payments.reference, remittanceId),
          eq(payments.method, 'direct_debit'),
          isNull(payments.cancelledAt),
        ),
      )
      .orderBy(asc(invoices.number))
    if (rows.length === 0) {
      const [any] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.reference, remittanceId))
        .limit(1)
      if (!any) return undefined
      throw new RemittanceError(['tous les prélèvements de cette remise ont été annulés'])
    }
    const { creditor, timeZone } = await loadCreditor(tx)
    const createdAt = rows.reduce((earliest, row) => (row.createdAt < earliest ? row.createdAt : earliest), rows[0].createdAt)
    const transactions: SepaDirectDebit[] = rows.map((row) => ({
      endToEndId: row.number as string,
      amountCents: row.amountCents,
      mandateReference: row.mandateReference,
      mandateSignedOn: row.mandateSignedOn,
      sequenceType: sepaSequenceFor(row.sequenceType, Boolean(row.collectedBefore)),
      debtorName: row.debtorName,
      debtorIban: debtorIban({ ...row, reference: row.mandateReference }),
      debtorBic: row.bic,
      remittanceInformation: `Facture ${row.number}`,
    }))
    try {
      const xml = buildPain008({
        messageId: remittanceId,
        createdAt: wallClockSeconds(createdAt, timeZone),
        requestedCollectionDate: rows[0].paidOn,
        creditor,
        transactions,
      })
      return {
        fileName: `${remittanceId}.xml`,
        xml,
        count: transactions.length,
        totalCents: transactions.reduce((total, transaction) => total + transaction.amountCents, 0),
      }
    } catch (error) {
      if (error instanceof SepaExportError) throw new RemittanceError(error.problems)
      throw error
    }
  })
}
