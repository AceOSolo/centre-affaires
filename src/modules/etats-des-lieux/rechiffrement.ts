import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import {
  openDocument,
  sealDocument,
  sealedKeyVersion,
  type DocumentKeyring,
} from '../../lib/chiffrement-documents.ts'
import type { ObjectStore } from '../courrier/reprise-chiffrement.ts'
import { inspectionPhotos } from './schema.ts'

/**
 * Rechiffrement des photos d'états des lieux après une rotation de clé (R33,
 * ADR 020, ADR 041).
 *
 * Même discipline que la reprise des numérisations
 * (`courrier/reprise-chiffrement.ts`), lancée par `infra/chiffrer-documents.ts`
 * en essai à blanc par défaut :
 *
 * - le fichier est réécrit **à la même clé de stockage**, avec la clé
 *   courante ; la ligne est verrouillée (`for update skip locked`) le temps de
 *   la lecture, du chiffrement et de l'écriture ;
 * - la version de clé de la ligne ne change que par la base
 *   (`rekey_inspection_photo()`, migration 0044) : la garde des photos refuse
 *   toute autre écriture, et laisse passer celle-là même sur un état des
 *   lieux clos — son contenu, lui, ne change pas ;
 * - une reprise interrompue entre l'écriture du fichier et celle de la base
 *   laisse un objet déjà chiffré avec la clé courante : la suivante
 *   l'authentifie et enregistre sa version, sans le rechiffrer ;
 * - un objet absent, tronqué ou d'une autre taille que celle du dépôt n'est
 *   pas touché : il est signalé.
 *
 * Les photos purgées ou retirées d'un brouillon n'ont plus de fichier : elles
 * ne sont pas concernées. Tant que l'essai à blanc en trouve, l'ancienne clé
 * reste dans l'environnement (`DOCUMENTS_ENCRYPTION_KEY_<N>`).
 */

export type PhotoRekeyReport = {
  /** Photos à rechiffrer, par version de clé : « clé 1 ». */
  pending: Record<string, number>
  /** Rechiffrées avec la clé courante. */
  rotated: number
  /** Déjà rechiffrées dans le stockage par une reprise interrompue : seule la base est mise à jour. */
  recorded: number
  /** Traitées entre-temps par ailleurs (purgées, ou rechiffrées par une autre reprise). */
  skipped: number
  /** Lignes vivantes dont l'objet manque au stockage. */
  missing: string[]
  /** Photos laissées telles quelles, avec la raison. */
  failed: { id: string; error: string }[]
}

/** À traiter : vivante, et chiffrée avec une autre clé que la courante. */
const needsWork = (currentVersion: number) =>
  and(isNull(inspectionPhotos.deletedAt), ne(inspectionPhotos.encryptionKeyVersion, currentVersion))

type Outcome = 'rotated' | 'recorded' | 'skipped' | 'missing'

async function processPhoto(
  tx: Transaction,
  id: string,
  store: ObjectStore,
  keyring: DocumentKeyring,
): Promise<Outcome> {
  const current = keyring.currentVersion
  const [row] = await tx
    .select({
      storageKey: inspectionPhotos.storageKey,
      byteSize: inspectionPhotos.byteSize,
      encryptionKeyVersion: inspectionPhotos.encryptionKeyVersion,
    })
    .from(inspectionPhotos)
    .where(and(eq(inspectionPhotos.id, id), needsWork(current)))
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
  const [recorded] = await tx.execute<{ done: boolean }>(
    sql`select rekey_inspection_photo(${id}::uuid, ${row.encryptionKeyVersion}::integer, ${current}::integer) as done`,
  )
  if (!recorded?.done) {
    throw new Error('La base n’a pas enregistré la nouvelle version de clé : photo à reprendre.')
  }
  return interrupted ? 'recorded' : 'rotated'
}

export async function rekeyInspectionPhotos(options: {
  database: Database
  tenantId: string
  store: ObjectStore
  keyring: DocumentKeyring
  /** Sans lui, essai à blanc : rien n'est lu ni écrit dans le stockage, rien en base. */
  apply: boolean
}): Promise<PhotoRekeyReport> {
  const { database, tenantId, store, keyring, apply } = options
  const current = keyring.currentVersion

  const candidates = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ id: inspectionPhotos.id, version: inspectionPhotos.encryptionKeyVersion })
        .from(inspectionPhotos)
        .where(needsWork(current))
        .orderBy(asc(inspectionPhotos.createdAt), asc(inspectionPhotos.id)),
    database,
  )

  const report: PhotoRekeyReport = {
    pending: {},
    rotated: 0,
    recorded: 0,
    skipped: 0,
    missing: [],
    failed: [],
  }
  for (const { version } of candidates) {
    const label = `clé ${version}`
    report.pending[label] = (report.pending[label] ?? 0) + 1
  }
  if (!apply) return report

  for (const { id } of candidates) {
    try {
      // Une transaction par photo : une erreur n'annule qu'elle, et le verrou
      // ne dure que le temps d'un fichier.
      const outcome = await withTenant(tenantId, (tx) => processPhoto(tx, id, store, keyring), database)
      if (outcome === 'missing') report.missing.push(id)
      else report[outcome] += 1
    } catch (error) {
      report.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
