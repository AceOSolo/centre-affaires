import { and, asc, eq, isNull, ne, or } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import {
  openDocument,
  sealDocument,
  sealedKeyVersion,
  type DocumentKeyring,
} from '../../lib/chiffrement-documents.ts'
import { mailScans } from './schema.ts'

/**
 * Reprise du chiffrement au repos (R22, ADR 020).
 *
 * Chiffre les numérisations déposées en clair avant le chiffrement
 * (`encryption_key_version` nul), et rechiffre avec la clé courante celles
 * d'une clé précédente, après une rotation. Lancée par
 * `infra/chiffrer-documents.ts`, en essai à blanc par défaut.
 *
 * Rejouable sans risque, objet par objet :
 *
 * - l'objet est réécrit **à la même clé de stockage** : aucune copie en clair
 *   ne survit à côté de sa version chiffrée, et la ligne n'a pas à changer de
 *   `storage_key` ;
 * - la ligne est verrouillée (`for update skip locked`) le temps de la lecture,
 *   du chiffrement et de l'écriture : deux reprises simultanées ne traitent
 *   jamais le même objet ;
 * - une reprise interrompue entre l'écriture du chiffré et celle de la base
 *   laisse un objet déjà chiffré avec la clé courante, que la base croit en
 *   clair : la reprise suivante l'authentifie et enregistre sa version, sans
 *   le rechiffrer. Entre-temps, la lecture le déchiffre grâce à son en-tête.
 *
 * Un objet absent, tronqué, ou dont la taille diffère de celle enregistrée au
 * dépôt n'est pas touché : il est signalé, pour qu'une personne regarde.
 */

/** Le stockage, réduit à ce dont la reprise a besoin. */
export type ObjectStore = {
  /** Contenu de l'objet, ou `undefined` s'il n'existe pas. */
  read(key: string): Promise<Uint8Array | undefined>
  write(key: string, bytes: Uint8Array): Promise<void>
}

export type EncryptionReport = {
  /** Numérisations à traiter, par version de clé : `clair` pour celles jamais chiffrées. */
  pending: Record<string, number>
  /** Chiffrées pour la première fois. */
  encrypted: number
  /** Rechiffrées avec la clé courante, après une rotation. */
  rotated: number
  /** Déjà chiffrées dans le stockage par une reprise interrompue : seule la base est mise à jour. */
  recorded: number
  /** Traitées entre-temps par ailleurs (purgées, ou chiffrées par une autre reprise). */
  skipped: number
  /** Lignes actives dont l'objet manque au stockage. */
  missing: string[]
  /** Objets laissés tels quels, avec la raison. */
  failed: { id: string; error: string }[]
}

/** À traiter : actif, et pas encore chiffré avec la clé courante. */
const needsWork = (currentVersion: number) =>
  and(
    isNull(mailScans.deletedAt),
    or(isNull(mailScans.encryptionKeyVersion), ne(mailScans.encryptionKeyVersion, currentVersion)),
  )

type Outcome = 'encrypted' | 'rotated' | 'recorded' | 'skipped' | 'missing'

async function processScan(
  tx: Transaction,
  id: string,
  store: ObjectStore,
  keyring: DocumentKeyring,
): Promise<Outcome> {
  const current = keyring.currentVersion
  const [row] = await tx
    .select({
      storageKey: mailScans.storageKey,
      byteSize: mailScans.byteSize,
      encryptionKeyVersion: mailScans.encryptionKeyVersion,
    })
    .from(mailScans)
    .where(and(eq(mailScans.id, id), needsWork(current)))
    .for('update', { skipLocked: true })
  if (!row) return 'skipped'

  const stored = await store.read(row.storageKey)
  if (stored === undefined) return 'missing'

  // Déjà chiffré avec la clé courante : une reprise s'est arrêtée avant
  // d'écrire la base. On authentifie, puis on enregistre.
  const interrupted = sealedKeyVersion(stored) === current
  const plain = openDocument(
    stored,
    interrupted ? current : row.encryptionKeyVersion,
    row.storageKey,
    keyring,
  )
  if (plain.byteLength !== row.byteSize) {
    throw new Error(
      `${plain.byteLength} octets lus, ${row.byteSize} enregistrés au dépôt : objet tronqué ou remplacé, laissé tel quel.`,
    )
  }

  if (!interrupted) {
    const sealed = sealDocument(plain, row.storageKey, keyring)
    await store.write(row.storageKey, sealed.bytes)
  }
  await tx.update(mailScans).set({ encryptionKeyVersion: current }).where(eq(mailScans.id, id))

  if (interrupted) return 'recorded'
  return row.encryptionKeyVersion === null ? 'encrypted' : 'rotated'
}

export async function encryptStoredScans(options: {
  database: Database
  tenantId: string
  store: ObjectStore
  keyring: DocumentKeyring
  /** Sans lui, essai à blanc : rien n'est lu ni écrit dans le stockage, rien en base. */
  apply: boolean
}): Promise<EncryptionReport> {
  const { database, tenantId, store, keyring, apply } = options
  const current = keyring.currentVersion

  const candidates = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: mailScans.id, version: mailScans.encryptionKeyVersion })
        .from(mailScans)
        .where(needsWork(current))
        // Le plus ancien d'abord, dans l'ordre de `mail_scans_unencrypted_idx`.
        .orderBy(asc(mailScans.createdAt), asc(mailScans.id)),
    database,
  )

  const report: EncryptionReport = {
    pending: {},
    encrypted: 0,
    rotated: 0,
    recorded: 0,
    skipped: 0,
    missing: [],
    failed: [],
  }
  for (const { version } of candidates) {
    const label = version === null ? 'clair' : `clé ${version}`
    report.pending[label] = (report.pending[label] ?? 0) + 1
  }
  if (!apply) return report

  for (const { id } of candidates) {
    try {
      // Une transaction par objet : une erreur n'annule que lui, et le verrou
      // ne dure que le temps d'un fichier.
      const outcome = await withTenant(tenantId, (tx) => processScan(tx, id, store, keyring), database)
      if (outcome === 'missing') report.missing.push(id)
      else report[outcome] += 1
    } catch (error) {
      report.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
