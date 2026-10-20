import { createHmac } from 'node:crypto'

import { CappedMap, createChallenge, randomInt } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { verify } from 'altcha-lib/frameworks/shared'

/**
 * Preuve de travail ALTCHA (ADR 047) : avant d'envoyer un formulaire sans
 * compte, le navigateur résout un calcul de quelques secondes, en arrière-plan.
 * Rien d'insurmontable pour une personne ; ruineux pour un robot qui enverrait
 * des milliers de demandes.
 *
 * Logiciel libre, entièrement servi par l'application : le défi vient de
 * `/api/anti-robot`, la réponse est vérifiée ici. Aucun service tiers, aucun
 * cookie, aucune donnée du visiteur ne quitte le serveur (hébergement EU).
 */

export type ReglagesPreuve = {
  /** Secret d'où sont dérivées les signatures des défis. */
  secret: string
  /** Coût d'une tentative (itérations PBKDF2). */
  cout: number
  /** Nombre de tentatives à faire, tiré entre ces deux bornes. */
  tentatives: readonly [min: number, max: number]
  validiteMinutes: number
}

/**
 * Réglage mesuré : 2 000 × 2 000 à 4 000 tentatives, environ 3,5 s sur un
 * seul cœur, une à deux secondes sur un ordinateur avec les workers du
 * widget, quelques secondes sur un téléphone — pendant que la personne
 * saisit ses coordonnées. La vérification, elle, prend une milliseconde.
 * Une demi-heure de validité : le formulaire de réservation compte cinq
 * étapes.
 */
const PRODUCTION = { cout: 2000, tentatives: [2000, 4000], validiteMinutes: 30 } as const

const deriver = (secret: string, usage: string) => createHmac('sha256', secret).update(`altcha:${usage}`).digest('hex')

export function creerPreuveHumaine(reglages: ReglagesPreuve) {
  const signature = deriver(reglages.secret, 'signature')
  const cle = deriver(reglages.secret, 'cle')
  // Une réponse ne sert qu'une fois. En mémoire : un seul conteneur (ADR 013) ;
  // au-delà de 10 000, les plus anciennes sortent, déjà expirées en pratique.
  // N'y entrent que des réponses justes : chacune a coûté son calcul.
  const dejaServies = new CappedMap<string, true>({ maxSize: 10_000 })

  return {
    /** Un défi neuf, signé, à envoyer au widget. */
    defi() {
      return createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost: reglages.cout,
        counter: randomInt(...reglages.tentatives),
        deriveKey,
        expiresAt: new Date(Date.now() + reglages.validiteMinutes * 60_000),
        hmacSignatureSecret: signature,
        hmacKeySignatureSecret: cle,
      })
    },

    /** Vrai si la réponse est juste, signée par ce serveur, à temps et jamais servie. */
    async verifier(reponse: unknown): Promise<boolean> {
      if (typeof reponse !== 'string' || reponse === '') return false
      // Vérifiée d'abord sans mémoire : `verify()` d'altcha-lib inscrirait le
      // défi avant d'en contrôler la signature, et des réponses forgées, qui ne
      // coûtent rien, rempliraient la mémoire jusqu'à en chasser des réponses
      // justes, alors réutilisables.
      const { error, payload } = await verify(reponse, deriveKey, signature, cle)
      // Seuls les défis de ce serveur (défi et solution) : pas les réponses
      // d'un service ALTCHA hébergé, que le site n'emploie pas.
      if (error !== null || !payload || !('challenge' in payload)) return false
      // Le défi est signé : son aléa (`nonce`) ne peut pas être changé. Lu et
      // inscrit sans attente entre les deux, deux envois simultanés de la même
      // réponse ne passent pas tous les deux.
      const defi = payload.challenge.parameters.nonce
      if (dejaServies.has(defi)) return false
      dejaServies.set(defi, true)
      return true
    },
  }
}

// Création paresseuse, comme `getAuth()` : `next build` charge ce module sans
// les secrets d'exécution.
let instance: ReturnType<typeof creerPreuveHumaine> | undefined

export function preuveHumaine() {
  if (!instance) {
    const secret = process.env.AUTH_SECRET
    if (!secret) throw new Error('AUTH_SECRET manquant (voir .env.example).')
    instance = creerPreuveHumaine({ secret, ...PRODUCTION })
  }
  return instance
}
