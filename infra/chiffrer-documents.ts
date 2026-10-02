/**
 * Reprise du chiffrement des documents stockés (R22, ADR 020) et des IBAN des
 * mandats SEPA (R16, ADR 034).
 *
 * Chiffre les numérisations de courrier déposées en clair avant le
 * chiffrement, et, après une rotation de clé, rechiffre avec la clé courante
 * celles de la clé précédente — ainsi que les IBAN des mandats, chiffrés en
 * base avec la même clé. Procédure complète : `infra/serveur/README.md`,
 * « Chiffrement des documents ».
 *
 *   node --env-file=<fichier> infra/chiffrer-documents.ts              # essai à blanc
 *   node --env-file=<fichier> infra/chiffrer-documents.ts --appliquer  # chiffre
 *
 * Variables lues : APP_DATABASE_URL (rôle applicatif, jamais le propriétaire),
 * AWS_* (stockage, région de l'Union contrôlée), DOCUMENTS_ENCRYPTION_KEY,
 * DOCUMENTS_ENCRYPTION_KEY_VERSION et, pendant une rotation,
 * DOCUMENTS_ENCRYPTION_KEY_<N>. Aucun fichier `.env` n'est chargé d'office :
 * l'environnement visé se désigne explicitement.
 *
 * Sans `--appliquer`, rien n'est lu ni écrit dans le stockage : le script
 * compte ce qu'il y a à faire et vérifie le trousseau. Rejouable autant de fois
 * que nécessaire : un objet déjà chiffré avec la clé courante n'est plus
 * sélectionné, et une reprise interrompue se termine à la suivante.
 */
import { parseArgs } from 'node:util'

import { createDatabase } from '../src/db/index.ts'
import { DEFAULT_TENANT_ID } from '../src/db/tenants.ts'
import { documentKeyringFromEnv } from '../src/lib/chiffrement-documents.ts'
import { putObject, readObjectBytes } from '../src/lib/stockage.ts'
import { encryptStoredScans, type ObjectStore } from '../src/modules/courrier/reprise-chiffrement.ts'
import { inspectionPhotosOnPreviousKeys } from '../src/modules/etats-des-lieux/conservation.ts'
import { rekeyMandateIbans } from '../src/modules/facturation/mandats-rechiffrement.ts'

const { values } = parseArgs({
  options: {
    appliquer: { type: 'boolean', default: false },
    centre: { type: 'string', default: DEFAULT_TENANT_ID },
  },
})

const url = process.env.APP_DATABASE_URL
if (!url) {
  console.error('APP_DATABASE_URL manquant : le rôle applicatif de l’environnement visé (voir .env.example).')
  process.exit(1)
}

// Avant toute connexion : une clé absente ou mal recopiée arrête tout.
const keyring = documentKeyringFromEnv()

/** Le stockage réel. Un objet absent n'est pas une panne : il est signalé. */
const store: ObjectStore = {
  async read(key) {
    try {
      return await readObjectBytes(key)
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return undefined
      throw error
    }
  },
  write: (key, bytes) => putObject(key, bytes, 'application/octet-stream'),
}

const { client, db } = createDatabase(url, { onnotice: () => {} })

try {
  const report = await encryptStoredScans({
    database: db,
    tenantId: values.centre,
    store,
    keyring,
    apply: values.appliquer,
  })

  const pending = Object.entries(report.pending)
  console.log(`Clé courante : version ${keyring.currentVersion}.`)
  console.log(
    pending.length === 0
      ? 'Aucune numérisation à chiffrer : la reprise est terminée.'
      : `À traiter : ${pending.map(([label, count]) => `${count} (${label})`).join(', ')}.`,
  )

  if (!values.appliquer) {
    if (pending.length > 0) console.log('Essai à blanc : rien n’a été modifié. Relancer avec --appliquer.')
  } else {
    console.log(
      `Chiffrées : ${report.encrypted} · rechiffrées : ${report.rotated} · ` +
        `déjà chiffrées, base mise à jour : ${report.recorded} · traitées ailleurs : ${report.skipped}.`,
    )
    for (const id of report.missing) console.error(`Objet absent du stockage : mail_scans ${id}`)
    for (const { id, error } of report.failed) console.error(`Laissée telle quelle : mail_scans ${id} — ${error}`)
    if (report.missing.length > 0 || report.failed.length > 0) process.exitCode = 1
  }

  // Les IBAN des mandats SEPA, chiffrés en base avec la même clé (ADR 034).
  const mandates = await rekeyMandateIbans({
    database: db,
    tenantId: values.centre,
    keyring,
    apply: values.appliquer,
  })
  const pendingMandates = Object.entries(mandates.pending)
  console.log(
    pendingMandates.length === 0
      ? 'Aucun IBAN de mandat à rechiffrer.'
      : `IBAN de mandats à rechiffrer : ${pendingMandates.map(([label, count]) => `${count} (${label})`).join(', ')}.`,
  )
  if (values.appliquer) {
    console.log(`IBAN rechiffrés : ${mandates.rotated} · traités ailleurs : ${mandates.skipped}.`)
    for (const { id, error } of mandates.failed) console.error(`Laissé tel quel : sepa_mandates ${id} — ${error}`)
    if (mandates.failed.length > 0) process.exitCode = 1
  }

  // Les photos d'états des lieux ne se rechiffrent pas : la base fige la clé
  // d'une photo déposée (ADR 039). On dit seulement quelles clés précédentes
  // doivent rester dans l'environnement tant qu'elles existent.
  const photos = Object.entries(
    await inspectionPhotosOnPreviousKeys({
      database: db,
      tenantId: values.centre,
      currentVersion: keyring.currentVersion,
    }),
  )
  if (photos.length > 0) {
    console.log(
      `Photos d’états des lieux chiffrées avec une clé précédente : ${photos
        .map(([version, count]) => `${count} (clé ${version})`)
        .join(', ')}. Elles restent lisibles tant que ces clés restent configurées ` +
        '(DOCUMENTS_ENCRYPTION_KEY_<N>) ; ne les retirez qu’une fois ces photos purgées.',
    )
  }
} finally {
  await client.end()
}
