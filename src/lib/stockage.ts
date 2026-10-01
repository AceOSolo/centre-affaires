import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/**
 * Stockage des fichiers : Neon Object Storage, compatible S3 (ADR 015).
 *
 * Le bucket `uploads` est déclaré privé dans `neon.ts`. Aucun fichier n'y est
 * jamais servi par une URL directe : l'application le lit et le renvoie, après
 * avoir vérifié le droit d'accès et journalisé la consultation.
 *
 * Ce module transporte des octets, il ne chiffre pas : les documents passent
 * par `chiffrement-documents.ts` avant d'arriver ici (ADR 020).
 *
 * Les identifiants suivent la branche Neon, comme la base : `neon env pull`
 * écrit `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` et
 * `AWS_REGION`, que le SDK lit dans l'environnement.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} manquant : lancer \`neon env pull\` (stockage objet de la branche).`)
  }
  return value
}

/**
 * Régions de stockage situées dans l'Union européenne (R33 ; `CLAUDE.md` :
 * « région EU obligatoire »), au nommage AWS, celui de Neon.
 *
 * Une liste fermée plutôt qu'un préfixe `eu-` : chez AWS, `eu-west-2` est
 * Londres et `eu-central-2` Zurich, hors de l'Union. Changer de fournisseur
 * (Scaleway, OVHcloud) demande d'ajouter ici ses régions européennes : c'est
 * voulu, la région se choisit, elle ne se découvre pas en production.
 */
export const EU_STORAGE_REGIONS: Readonly<Record<string, string>> = {
  'eu-central-1': 'Francfort',
  'eu-west-1': 'Irlande',
  'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm',
  'eu-south-1': 'Milan',
  'eu-south-2': 'Aragon',
}

/** Erreur de configuration : le stockage refuse de démarrer plutôt que d'improviser. */
export class StorageRegionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageRegionError'
  }
}

/**
 * Rend la région si elle est dans l'Union européenne, et refuse sinon : des
 * scans de courrier ne partent pas hors d'Europe parce qu'une variable a été
 * mal recopiée.
 */
export function assertEuropeanRegion(region: string | undefined): string {
  const value = region?.trim()
  if (!value) {
    throw new StorageRegionError(
      'AWS_REGION manquant : lancer `neon env pull` (stockage objet de la branche).',
    )
  }
  if (!Object.hasOwn(EU_STORAGE_REGIONS, value)) {
    const accepted = Object.entries(EU_STORAGE_REGIONS)
      .map(([name, city]) => `${name} (${city})`)
      .join(', ')
    throw new StorageRegionError(
      `Stockage refusé : AWS_REGION vaut « ${value} », qui n'est pas une région de l'Union européenne. ` +
        `Les documents du centre (courrier, photos) ne sont stockés qu'en région UE (CLAUDE.md, RGPD). ` +
        `Régions acceptées : ${accepted}.`,
    )
  }
  return value
}

// Création paresseuse, comme `getAuth()` : le build ne doit pas exiger les
// identifiants de stockage.
let client: S3Client | undefined

function s3(): S3Client {
  client ??= new S3Client({
    // Exigé explicitement : sans lui, le SDK s'adresserait à AWS S3 dans la
    // région par défaut, hors de l'hébergement EU que le projet impose.
    endpoint: required('AWS_ENDPOINT_URL_S3'),
    // Contrôlée avant toute connexion : une région hors de l'Union ne reçoit
    // jamais un octet.
    region: assertEuropeanRegion(process.env.AWS_REGION),
    // Neon n'accepte que l'adressage par chemin.
    forcePathStyle: true,
  })
  return client
}

const BUCKET = 'uploads'

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  )
}

/**
 * Contenu complet de l'objet. Pas de flux : un document chiffré ne se rend
 * qu'une fois authentifié en entier, et un scan pèse au plus 10 Mo.
 */
export async function readObjectBytes(key: string): Promise<Uint8Array> {
  const result = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  if (!result.Body) throw new Error(`Objet vide : ${key}`)
  return result.Body.transformToByteArray()
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}
