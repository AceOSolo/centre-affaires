import { toIsoDate } from '../../lib/dates.ts'

/**
 * Repérer un pli dans la pile du jour (ADR 057).
 *
 * Quand un client demande l'ouverture, la numérisation ou la réexpédition
 * d'un pli, l'accueil doit retrouver **ce** pli parmi ceux de l'entreprise. La
 * photo de l'enveloppe, le type et l'expéditeur aident ; le rang du pli dans
 * sa journée de réception tranche entre deux lettres semblables :
 * « pli 3 sur 5 du 04/11 ».
 *
 * Le rang se calcule, il ne se stocke pas : par entreprise, sur les plis
 * reçus le même jour du centre (fuseau du centre, décision 4), dans l'ordre de
 * leur enregistrement — l'heure de réception, puis l'identifiant (UUID v7,
 * ordonné dans le temps), qui départage les plis d'une même saisie groupée :
 * ses identifiants sont triés à l'enregistrement, dans l'ordre des photos
 * (`orderedIds`, ADR 058), car un UUID v7 ne porte que la milliseconde.
 * Un pli retiré (enregistré par erreur) ne compte pas : il n'est plus dans la
 * pile de l'entreprise.
 */
export type MailSpot = {
  /** Rang du pli dans sa journée, à partir de 1. */
  rank: number
  /** Plis de l'entreprise reçus ce jour-là. */
  total: number
  /** Jour de réception, dans le fuseau du centre (« 2026-11-04 »). */
  day: string
}

type SpotItem = { id: string; clientId: string; receivedAt: Date }

/**
 * Rang de chaque pli dans sa journée de réception, par entreprise. Les plis
 * passés sont ceux de la pile : les retirés doivent en être exclus par
 * l'appelant.
 */
export function spotsOfDay(items: readonly SpotItem[], timeZone: string): Map<string, MailSpot> {
  const piles = new Map<string, SpotItem[]>()
  for (const item of items) {
    const key = `${item.clientId}|${toIsoDate(item.receivedAt, timeZone)}`
    const pile = piles.get(key)
    if (pile) pile.push(item)
    else piles.set(key, [item])
  }
  const spots = new Map<string, MailSpot>()
  for (const [key, pile] of piles) {
    const day = key.slice(key.indexOf('|') + 1)
    pile.sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    pile.forEach((item, index) => spots.set(item.id, { rank: index + 1, total: pile.length, day }))
  }
  return spots
}

/**
 * « pli 3 sur 5 du 04/11 », « seul pli du 04/11 » ; l'année s'ajoute quand
 * le pli n'est pas de l'année en cours (« pli 1 sur 2 du 28/12/2025 »).
 * `today` est le jour du centre (`todayIsoDate`).
 */
export function spotLabel(spot: MailSpot, today: string): string {
  const [year, month, day] = spot.day.split('-')
  const date = year === today.slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`
  return spot.total === 1 ? `seul pli du ${date}` : `pli ${spot.rank} sur ${spot.total} du ${date}`
}
