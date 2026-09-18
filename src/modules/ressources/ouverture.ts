import { addDaysToIsoDate, wallClockToUtc } from '../../lib/dates.ts'

/**
 * Quand une ressource est ouverte.
 *
 * Jusqu'ici l'application supposait une ouverture de 7h à 20h, sept jours sur
 * sept : le planning s'étendait sur cette plage et le site public proposait des
 * créneaux le dimanche matin. Ce module remplace cette constante par des règles
 * saisies.
 *
 * Les règles sont en heure murale — « ouvre à 9h00 » ne bouge pas au changement
 * d'heure. La conversion en instants a lieu ici, jour par jour, ce qui donne
 * une journée d'ouverture de 9 heures même lorsque la journée civile en fait 23
 * ou 25 (décision 4).
 */

/** Intervalle d'instants, bornes `[)` comme partout ailleurs. */
export type TimeRange = { startsAt: Date; endsAt: Date }

/** `weekday` suit ISO 8601 : 1 = lundi … 7 = dimanche. */
export type OpeningRule = {
  resourceId: string | null
  weekday: number
  opensAt: string
  closesAt: string
}

export type ClosurePeriod = {
  resourceId: string | null
  startsOn: string
  endsOn: string
}

/** Jour de la semaine ISO d'une date de calendrier, sans passer par un fuseau. */
export function isoWeekday(isoDate: string): number {
  const utc = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  )
  // getUTCDay rend 0 pour dimanche ; ISO attend 7.
  return new Date(utc).getUTCDay() || 7
}

/**
 * Règles applicables à une ressource.
 *
 * Les règles propres à une ressource **remplacent** celles du centre, elles ne
 * s'y ajoutent pas. Sinon une salle ouverte le samedi dans un centre fermé le
 * samedi serait exprimable, mais pas une salle fermée le lundi dans un centre
 * ouvert le lundi — et c'est le cas le plus courant.
 */
export function rulesForResource(
  rules: readonly OpeningRule[],
  resourceId: string,
): OpeningRule[] {
  const own = rules.filter((rule) => rule.resourceId === resourceId)
  return own.length > 0 ? own : rules.filter((rule) => rule.resourceId === null)
}

/** Une fermeture du centre vaut pour tout ; celle d'une ressource, pour elle seule. */
export function closuresForResource(
  closures: readonly ClosurePeriod[],
  resourceId: string,
): ClosurePeriod[] {
  return closures.filter(
    (closure) => closure.resourceId === null || closure.resourceId === resourceId,
  )
}

export function isClosedOn(closures: readonly ClosurePeriod[], isoDate: string): boolean {
  return closures.some((closure) => closure.startsOn <= isoDate && isoDate <= closure.endsOn)
}

/** Fusionne les plages qui se chevauchent ou se touchent, et les ordonne. */
function merge(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const merged: TimeRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startsAt.getTime() <= last.endsAt.getTime()) {
      if (range.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = range.endsAt
      continue
    }
    merged.push({ startsAt: range.startsAt, endsAt: range.endsAt })
  }

  return merged
}

/** `09:00:00` ou `09:00` → `09:00`, le format attendu par `wallClockToUtc`. */
const hhmm = (time: string) => time.slice(0, 5)

/**
 * Fenêtres d'ouverture d'une ressource pour une journée, en instants UTC.
 *
 * Renvoie un tableau vide quand la ressource est fermée : ni règle pour ce jour
 * de semaine, ou une fermeture exceptionnelle qui couvre la date. Le tableau
 * vide est une réponse, pas une absence de réponse — c'est ce qui permet à une
 * page publique d'écrire « fermé » plutôt que de ne rien afficher.
 *
 * Une plage qui finit à `24:00` court jusqu'à minuit du lendemain ; au-delà,
 * la journée suivante prend le relais.
 */
export function openingWindows(
  isoDate: string,
  timeZone: string,
  options: {
    rules: readonly OpeningRule[]
    closures?: readonly ClosurePeriod[]
    resourceId: string
  },
): TimeRange[] {
  const closures = closuresForResource(options.closures ?? [], options.resourceId)
  if (isClosedOn(closures, isoDate)) return []

  const weekday = isoWeekday(isoDate)
  const applicable = rulesForResource(options.rules, options.resourceId).filter(
    (rule) => rule.weekday === weekday,
  )

  return merge(
    applicable.map((rule) => ({
      startsAt: wallClockToUtc(`${isoDate}T${hhmm(rule.opensAt)}`, timeZone),
      endsAt:
        hhmm(rule.closesAt) === '24:00'
          ? wallClockToUtc(`${addDaysToIsoDate(isoDate, 1)}T00:00`, timeZone)
          : wallClockToUtc(`${isoDate}T${hhmm(rule.closesAt)}`, timeZone),
    })),
  )
}

/** Enveloppe des fenêtres d'ouverture : première ouverture, dernière fermeture. */
export function openingExtent(windows: readonly TimeRange[]): TimeRange | undefined {
  if (windows.length === 0) return undefined
  return {
    startsAt: windows[0].startsAt,
    endsAt: windows[windows.length - 1].endsAt,
  }
}

/** Vrai si l'intervalle demandé tient entièrement dans les heures d'ouverture. */
export function isWithinOpeningHours(
  range: TimeRange,
  windows: readonly TimeRange[],
): boolean {
  return windows.some(
    (window) =>
      range.startsAt.getTime() >= window.startsAt.getTime() &&
      range.endsAt.getTime() <= window.endsAt.getTime(),
  )
}
