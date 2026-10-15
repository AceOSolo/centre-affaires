import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/**
 * Stockage des fichiers : tout service compatible S3 (ADR 015, ADR 042) —
 * MinIO sur le VPS, Scaleway, OVHcloud, AWS.
 *
 * Le bucket est privé. Aucun fichier n'y est jamais servi par une URL
 * directe : l'application le lit et le renvoie, après avoir vérifié le droit
 * d'accès et journalisé la consultation.
 *
 * Ce module transporte des octets, il ne chiffre pas : les documents passent
 * par `chiffrement-documents.ts` avant d'arriver ici (ADR 020).
 *
 * Configuration (`.env`) :
 *
 *   S3_ENDPOINT            URL du service (obligatoire)
 *   S3_REGION              région, dans la liste `EU_STORAGE_REGIONS` (obligatoire)
 *   S3_ACCESS_KEY_ID       clé d'accès (obligatoire)
 *   S3_SECRET_ACCESS_KEY   secret (obligatoire)
 *   S3_BUCKET              nom du bucket, `uploads` par défaut
 *   S3_FORCE_PATH_STYLE    adressage par chemin, `true` par défaut (MinIO)
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} manquant : variable du stockage objet S3 (voir .env.example).`)
  }
  return value
}

/**
 * Régions de stockage situées dans l'Union européenne (R33 ; `CLAUDE.md` :
 * « région EU obligatoire »).
 *
 * Une liste fermée plutôt qu'un préfixe `eu-` : chez AWS, `eu-west-2` est
 * Londres et `eu-central-2` Zurich, hors de l'Union. La région se choisit, elle
 * ne se découvre pas en production : un autre fournisseur demande d'ajouter
 * ici ses régions européennes. Sont déjà listées celles d'AWS, de Scaleway
 * (`fr-par`, `nl-ams`, `pl-waw`, point d'accès `s3.<région>.scw.cloud`) et
 * d'OVHcloud (`gra`, `sbg`, `rbx`, `de`, `waw`, point d'accès
 * `s3.<région>.io.cloud.ovh.net`). Un MinIO sur le VPS n'a pas de vraie
 * région : y configurer l'une des valeurs ci-dessous suffit.
 */
export const EU_STORAGE_REGIONS: Readonly<Record<string, string>> = {
  // AWS
  'eu-central-1': 'Francfort',
  'eu-west-1': 'Irlande',
  'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm',
  'eu-south-1': 'Milan',
  'eu-south-2': 'Aragon',
  // Scaleway
  'fr-par': 'Paris (Scaleway)',
  'nl-ams': 'Amsterdam (Scaleway)',
  'pl-waw': 'Varsovie (Scaleway)',
  // OVHcloud
  gra: 'Gravelines (OVHcloud)',
  sbg: 'Strasbourg (OVHcloud)',
  rbx: 'Roubaix (OVHcloud)',
  de: 'Francfort (OVHcloud)',
  waw: 'Varsovie (OVHcloud)',
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
      'S3_REGION manquant : région du stockage objet S3 (voir .env.example).',
    )
  }
  if (!Object.hasOwn(EU_STORAGE_REGIONS, value)) {
    const accepted = Object.entries(EU_STORAGE_REGIONS)
      .map(([name, city]) => `${name} (${city})`)
      .join(', ')
    throw new StorageRegionError(
      `Stockage refusé : S3_REGION vaut « ${value} », qui n'est pas une région de l'Union européenne. ` +
        `Les documents du centre (courrier, photos) ne sont stockés qu'en région UE (CLAUDE.md, RGPD). ` +
        `Régions acceptées : ${accepted}.`,
    )
  }
  return value
}

// Création paresseuse : le build ne doit pas exiger les identifiants de
// stockage.
let client: S3Client | undefined

function s3(): S3Client {
  client ??= new S3Client({
    // Exigé explicitement : sans lui, le SDK s'adresserait à AWS S3 dans la
    // région par défaut, hors de l'hébergement EU que le projet impose.
    endpoint: required('S3_ENDPOINT'),
    // Contrôlée avant toute connexion : une région hors de l'Union ne reçoit
    // jamais un octet.
    region: assertEuropeanRegion(process.env.S3_REGION),
    // Credentials passés explicitement : le SDK n'ira pas chercher ceux d'un
    // profil AWS ou d'un rôle de la machine.
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    },
    // MinIO et la plupart des services compatibles n'acceptent que
    // l'adressage par chemin : vrai par défaut.
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false',
  })
  return client
}

const bucket = () => process.env.S3_BUCKET || 'uploads'

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  )
}

/**
 * Contenu complet de l'objet. Pas de flux : un document chiffré ne se rend
 * qu'une fois authentifié en entier, et un scan pèse au plus 10 Mo.
 */
export async function readObjectBytes(key: string): Promise<Uint8Array> {
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  if (!result.Body) throw new Error(`Objet vide : ${key}`)
  return result.Body.transformToByteArray()
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}
