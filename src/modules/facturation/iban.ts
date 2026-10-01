import {
  documentKeyringFromEnv,
  openDocument,
  sealDocument,
  type DocumentKeyring,
} from '../../lib/chiffrement-documents.ts'

/**
 * IBAN d'un mandat de prélèvement SEPA (ADR 016, ADR 027) : jamais en clair
 * en base.
 *
 * Chiffré par l'application avec la clé des documents (ADR 020,
 * `DOCUMENTS_ENCRYPTION_KEY`), au format autoportant `CAD1` : la version de
 * clé est dans le chiffré et dans `sepa_mandates.iban_key_version`, ce qui
 * permet une rotation sans rendre illisibles les mandats existants.
 *
 * Le chiffré est lié à son mandat par ses données associées — centre et RUM,
 * qui ne changent jamais (SQLSTATE `CA007`) : un IBAN recopié sur le mandat
 * d'un autre client ne se déchiffre pas. La base, elle, refuse tout ce qui
 * n'a pas l'en-tête du format (`sepa_mandates_iban_sealed`).
 *
 * Écrire un mandat :
 *
 * ```ts
 * const sealed = sealIban(saisie, { tenantId, reference })
 * await tx.insert(sepaMandates).values({
 *   clientId, reference, debtorName, signedOn,
 *   ibanCiphertext: sealed.ciphertext,
 *   ibanKeyVersion: sealed.keyVersion,
 *   ibanLast4: sealed.last4,
 * })
 * ```
 *
 * Le lire (export bancaire, affichage complet sur demande) :
 * `openIban(mandate.ibanCiphertext, mandate.ibanKeyVersion, { tenantId, reference })`.
 * Partout ailleurs, afficher `maskIban(mandate.ibanLast4)`.
 */

/** Ce qui lie un IBAN chiffré à son mandat. */
export type IbanBinding = { tenantId: string; reference: string }

/** IBAN illisible ou invalide : la saisie est à reprendre. */
export class InvalidIbanError extends Error {
  constructor(message = 'IBAN invalide : vérifiez la saisie (clé de contrôle).') {
    super(message)
    this.name = 'InvalidIbanError'
  }
}

/** Majuscules, sans espace ni tiret : la forme électronique de l'IBAN. */
export function normalizeIban(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * Contrôle de l'IBAN (ISO 13616) : format, puis clé modulo 97. Les quatre
 * premiers caractères passent à la fin, chaque lettre devient deux chiffres
 * (A = 10 … Z = 35), et le nombre obtenu doit valoir 1 modulo 97.
 */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input)
  if (!/^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const digits = /[0-9]/.test(character)
      ? character
      : String(character.charCodeAt(0) - 55)
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** Clé des données associées : le centre et la RUM du mandat. */
function associatedKey({ tenantId, reference }: IbanBinding): string {
  return `sepa_mandates/${tenantId}/${reference}`
}

/**
 * Chiffre un IBAN pour le mandat `binding`. Lève `InvalidIbanError` sur un
 * IBAN invalide : un IBAN faux ne doit pas entrer, même chiffré.
 */
export function sealIban(
  input: string,
  binding: IbanBinding,
  keyring: DocumentKeyring = documentKeyringFromEnv(),
): { ciphertext: Buffer; keyVersion: number; last4: string } {
  const iban = normalizeIban(input)
  if (!isValidIban(iban)) throw new InvalidIbanError()
  const { bytes, keyVersion } = sealDocument(Buffer.from(iban, 'utf8'), associatedKey(binding), keyring)
  return { ciphertext: bytes, keyVersion, last4: iban.slice(-4) }
}

/**
 * Rend l'IBAN en clair. Lève `DocumentIntegrityError` si le chiffré a été
 * altéré, déplacé sur un autre mandat, ou chiffré avec une autre clé ;
 * `DocumentKeyError` si la version de clé manque à l'environnement.
 */
export function openIban(
  ciphertext: Uint8Array,
  keyVersion: number,
  binding: IbanBinding,
  keyring?: DocumentKeyring,
): string {
  const plain = openDocument(ciphertext, keyVersion, associatedKey(binding), keyring)
  return Buffer.from(plain).toString('utf8')
}

/** « •••• 0189 » : ce que l'interface affiche d'un IBAN, hors besoin explicite. */
export function maskIban(last4: string): string {
  return `•••• ${last4}`
}
