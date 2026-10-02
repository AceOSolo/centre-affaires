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

// Création paresseuse, comme `getAuth()` : le build ne doit pas exiger les
// identifiants de stockage.
let client: S3Client | undefined

function s3(): S3Client {
  client ??= new S3Client({
    // Exigé explicitement : sans lui, le SDK s'adresserait à AWS S3 dans la
    // région par défaut, hors de l'hébergement EU que le projet impose.
    endpoint: required('AWS_ENDPOINT_URL_S3'),
    region: required('AWS_REGION'),
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

/** Flux du fichier, à renvoyer tel quel dans une `Response`. */
export async function readObject(key: string): Promise<ReadableStream<Uint8Array>> {
  const result = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  if (!result.Body) throw new Error(`Objet vide : ${key}`)
  return result.Body.transformToWebStream() as ReadableStream<Uint8Array>
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}
