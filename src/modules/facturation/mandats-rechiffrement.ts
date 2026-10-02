import { and, asc, eq, ne } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import type { DocumentKeyring } from '../../lib/chiffrement-documents.ts'
import { openIban, sealIban } from './iban.ts'
import { sepaMandates } from './schema-factures.ts'

/**
 * Rechiffrement des IBAN des mandats SEPA après une rotation de la clé des
 * documents (R16, ADR 020, ADR 027, ADR 034).
 *
 * Un IBAN est chiffré par `sealIban` avec la clé courante, et lié à son
 * mandat (centre et RUM). Après une rotation, ceux de l'ancienne clé restent
 * lisibles tant qu'elle reste dans le trousseau ; pour la retirer, il faut les
 * rechiffrer avec la nouvelle. Lancé par `infra/chiffrer-documents.ts`, avec
 * les numérisations, en essai à blanc par défaut.
 *
 * Un mandat à la fois, chacun dans sa transaction et sous verrou (`for update
 * skip locked`) : une erreur n'annule que lui, deux reprises simultanées ne
 * traitent jamais le même. Les mandats révoqués ou archivés sont rechiffrés
 * aussi : leur IBAN reste dans la base, il doit rester lisible avec les clés
 * du trousseau. Rejouable : un mandat déjà à la clé courante n'est plus
 * sélectionné.
 */

export type MandateRekeyReport = {
  /** Mandats à rechiffrer, par version de clé. */
  pending: Record<string, number>
  /** Rechiffrés avec la clé courante. */
  rotated: number
  /** Traités entre-temps par une autre reprise. */
  skipped: number
  /** Laissés tels quels, avec la raison (clé ancienne absente, chiffré altéré). */
  failed: { id: string; error: string }[]
}

async function rekeyMandate(
  tx: Transaction,
  id: string,
  tenantId: string,
  keyring: DocumentKeyring,
): Promise<'rotated' | 'skipped'> {
  const [row] = await tx
    .select({
      reference: sepaMandates.reference,
      ciphertext: sepaMandates.ibanCiphertext,
      keyVersion: sepaMandates.ibanKeyVersion,
    })
    .from(sepaMandates)
    .where(and(eq(sepaMandates.id, id), ne(sepaMandates.ibanKeyVersion, keyring.currentVersion)))
    .for('update', { skipLocked: true })
  if (!row) return 'skipped'

  const binding = { tenantId, reference: row.reference }
  const iban = openIban(row.ciphertext, row.keyVersion, binding, keyring)
  const sealed = sealIban(iban, binding, keyring)
  await tx
    .update(sepaMandates)
    .set({ ibanCiphertext: sealed.ciphertext, ibanKeyVersion: sealed.keyVersion })
    .where(eq(sepaMandates.id, id))
  return 'rotated'
}

export async function rekeyMandateIbans(options: {
  database: Database
  tenantId: string
  keyring: DocumentKeyring
  /** Sans lui, essai à blanc : rien n'est écrit. */
  apply: boolean
}): Promise<MandateRekeyReport> {
  const { database, tenantId, keyring, apply } = options
  const candidates = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: sepaMandates.id, version: sepaMandates.ibanKeyVersion })
        .from(sepaMandates)
        .where(ne(sepaMandates.ibanKeyVersion, keyring.currentVersion))
        .orderBy(asc(sepaMandates.createdAt), asc(sepaMandates.id)),
    database,
  )

  const report: MandateRekeyReport = { pending: {}, rotated: 0, skipped: 0, failed: [] }
  for (const { version } of candidates) {
    const label = `clé ${version}`
    report.pending[label] = (report.pending[label] ?? 0) + 1
  }
  if (!apply) return report

  for (const { id } of candidates) {
    try {
      const outcome = await withTenant(tenantId, (tx) => rekeyMandate(tx, id, tenantId, keyring), database)
      report[outcome] += 1
    } catch (error) {
      report.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
