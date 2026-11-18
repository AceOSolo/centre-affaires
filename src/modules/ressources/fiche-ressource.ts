import { tariffUnitWords } from '../facturation/produits-dolibarr.ts'
import { rateUnits, type RateUnit } from '../facturation/schema.ts'
import type { RateCandidate } from '../facturation/tarifs.ts'
import type { ResourceType } from './schema.ts'

/**
 * Ce que la fiche d'une ressource montre de ses prix et de sa vitrine
 * (ADR 082), sans base ni Next : la page et les tests passent par ces règles.
 *
 * **La référence Dolibarr est déduite, jamais stockée** :
 * `tarif.<type>.<code de la ressource>.<unité>`, le code en minuscules. C'est
 * la convention que la route des produits lit (ADR 049,
 * `produits-dolibarr.ts`) et la clé par laquelle elle retrouve la ressource
 * (`lower(code)`). Changer la référence, c'est changer le code de la
 * ressource à l'écran « Modifier », puis la référence des produits dans
 * Dolibarr — comme les contrats reçus de Dolibarr, qui désignent eux aussi la
 * ressource par son code (ADR 066).
 */

/** Mot de chaque unité dans une référence : `demi-journee` pour la demi-journée. */
export const tariffUnitWordOf = Object.fromEntries(
  Object.entries(tariffUnitWords).map(([word, unit]) => [unit, word]),
) as Record<RateUnit, string>

/**
 * Le code de la ressource tel qu'il s'écrit dans la référence : en
 * minuscules, comme la route met en minuscules la référence reçue.
 */
export const tariffRefSegment = (code: string) => code.trim().toLowerCase()

/** Référence d'un prix propre à la ressource : `tarif.salle.sal-mb.journee`. */
export const resourceTariffRef = (type: ResourceType, code: string, unit: RateUnit) =>
  `tarif.${type}.${tariffRefSegment(code)}.${tariffUnitWordOf[unit]}`

/** Référence d'un prix qui vaut pour tout le type : `tarif.salle.journee`. */
export const typeTariffRef = (type: ResourceType, unit: RateUnit) => `tarif.${type}.${tariffUnitWordOf[unit]}`

/** Le modèle de référence de la ressource, l'unité laissée à choisir. */
export const resourceTariffPattern = (type: ResourceType, code: string) =>
  `tarif.${type}.${tariffRefSegment(code)}.<unité>`

/**
 * Pourquoi ce code ne peut pas servir de référence Dolibarr ; `undefined`
 * s'il le peut. Un point couperait la référence en un morceau de trop : la
 * route la refuserait comme illisible.
 */
export function tariffRefProblem(code: string): string | undefined {
  if (tariffRefSegment(code).includes('.')) {
    return `Le code « ${code} » contient un point : Dolibarr ne pourra pas lui envoyer de prix propre. Choisissez un code sans point (« S-101 » plutôt que « S.101 »).`
  }
  return undefined
}

/** Le prix d'une ressource pour une unité : le sien s'il en a un, sinon celui de son type. */
export type TariffLine = {
  unit: RateUnit
  /** Référence Dolibarr du prix propre à la ressource. */
  resourceRef: string
  /** Référence Dolibarr du prix du type. */
  typeRef: string
  /** Prix propre, en centimes HT ; nul sans prix propre. */
  resourceCents: number | null
  /** Prix du type, en centimes HT ; nul sans prix du type. */
  typeCents: number | null
}

/**
 * Les prix de la ressource dans la grille par défaut, unité par unité, dans
 * l'ordre des unités (de l'heure au mois) ; seules les unités qui ont un prix.
 * Le prix propre l'emporte, comme à la réservation (`pickRateItem`).
 */
export function tariffLines(
  resource: { id: string; resourceType: ResourceType; code: string },
  items: readonly RateCandidate[],
): TariffLine[] {
  const ofType = items.filter((item) => item.resourceType === resource.resourceType)
  return rateUnits.flatMap((unit) => {
    const own = ofType.find((item) => item.unit === unit && item.resourceId === resource.id)
    const shared = ofType.find((item) => item.unit === unit && item.resourceId === null)
    if (!own && !shared) return []
    return [
      {
        unit,
        resourceRef: resourceTariffRef(resource.resourceType, resource.code, unit),
        typeRef: typeTariffRef(resource.resourceType, unit),
        resourceCents: own?.amountCents ?? null,
        typeCents: shared?.amountCents ?? null,
      },
    ]
  })
}

/**
 * Types de ressource qui ont une vitrine sur le site : salles, bureaux,
 * camion, matériel. Un casier ne s'annonce pas (`listings`), une boîte aux
 * lettres se vend par la domiciliation.
 */
export const showcasedTypes: readonly ResourceType[] = ['salle', 'bureau', 'vehicule', 'materiel']

/**
 * La fiche gère les photos et vidéos d'une ressource vivante qui a une
 * vitrine, ou qui a déjà une annonce (créée depuis l'écran des annonces).
 */
export function showsMediaOnResource(type: ResourceType, hasListing: boolean, archived: boolean): boolean {
  return !archived && (hasListing || showcasedTypes.includes(type))
}
