import { getIP } from 'better-auth/api'

/**
 * Défenses contre les robots sur ce qui s'écrit sans compte : la demande de
 * réservation ou de devis du site public, et l'inscription (Better Auth).
 *
 * Une demande en attente occupe son créneau (trigger de `bookings`) : sans
 * plafond, un robot qui change d'adresse électronique à chaque envoi
 * bloquerait tout le planning. Le quota par adresse (`requests.ts`) ne l'en
 * empêche pas ; le plafond par adresse IP et le plafond du site, si.
 */

/**
 * Lecture de l'adresse IP derrière l'Apache du VPS (`infra/serveur`), qui
 * ajoute l'adresse du visiteur à droite de `X-Forwarded-For`. Ce qui est à sa
 * gauche vient du visiteur et peut être inventé : seule la dernière entrée
 * fait foi. La boucle locale, d'où Apache appelle l'application, est le seul
 * relais de confiance. Partagée avec Better Auth (`lib/auth/server.ts`) : le
 * site et la connexion comptent les mêmes adresses.
 */
export const adresseIpDerriereApache = { trustedProxies: ['127.0.0.1', '::1'] }

/**
 * Adresse IP du visiteur, ramenée à son réseau /64 en IPv6 (un abonné en
 * reçoit des milliers d'un coup). Null si aucune adresse fiable.
 */
export function ipDuVisiteur(enTetes: Headers): string | null {
  return getIP(enTetes, { advanced: { ipAddress: adresseIpDerriereApache } })
}

export type Plafond = { fenetreSecondes: number; max: number }

/**
 * Compteur à fenêtre glissante, en mémoire du serveur : l'application tourne
 * en un seul conteneur (ADR 013). Remis à zéro à chaque redémarrage, ce qui
 * suffit contre un robot ; un second conteneur demanderait un stockage commun.
 */
export function creerCompteur() {
  const passages = new Map<string, { fenetreMs: number; instants: number[] }>()

  const recents = (cle: string, plafond: Plafond, maintenant: number) =>
    (passages.get(cle)?.instants ?? []).filter((instant) => instant > maintenant - plafond.fenetreSecondes * 1000)

  function oublierLesAnciens(maintenant: number) {
    for (const [cle, { fenetreMs, instants }] of passages) {
      if (instants.every((instant) => instant <= maintenant - fenetreMs)) passages.delete(cle)
    }
  }

  return {
    /**
     * Compte un passage sous chacune des clés si **toutes** sont sous leur
     * plafond, sinon ne compte rien et rend la première clé dépassée.
     */
    passer(regles: readonly (readonly [cle: string, plafond: Plafond])[], maintenant = Date.now()): string | null {
      for (const [cle, plafond] of regles) {
        if (recents(cle, plafond, maintenant).length >= plafond.max) return cle
      }
      for (const [cle, plafond] of regles) {
        passages.set(cle, { fenetreMs: plafond.fenetreSecondes * 1000, instants: [...recents(cle, plafond, maintenant), maintenant] })
      }
      if (passages.size > 10_000) oublierLesAnciens(maintenant)
      return null
    },
  }
}

