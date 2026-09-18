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

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

/** « 08:00:00 » → « 8h00 », « 12:30:00 » → « 12h30 ». */
function heureLisible(time: string): string {
  const [heures, minutes] = time.split(':')
  return `${Number(heures)}h${minutes}`
}

/**
 * Horaires d'ouverture en une phrase : « Du lundi au vendredi, 8h00 – 18h00 ».
 *
 * Écrit pour que le site public cesse de répéter les horaires en dur : les
 * afficher depuis les mêmes lignes que celles qui décident des créneaux libres
 * évite qu'une page annonce une ouverture que le calendrier refuse.
 *
 * Les jours consécutifs aux mêmes horaires sont regroupés ; un jour fermé est
 * simplement absent. Renvoie `undefined` quand aucune règle n'existe — au
 * lecteur de décider quoi afficher, pas à cette fonction d'inventer des
 * horaires.
 */
export function formatOpeningSummary(
  rules: readonly OpeningRule[],
  resourceId: string | null = null,
): string | undefined {
  const applicable = resourceId
    ? rulesForResource(rules, resourceId)
    : rules.filter((rule) => rule.resourceId === null)
  if (applicable.length === 0) return undefined

  // Un jour peut porter plusieurs plages — une journée coupée à midi.
  const parJour = new Map<number, { opensAt: string; texte: string }[]>()
  for (const rule of applicable) {
    const plages = parJour.get(rule.weekday) ?? []
    plages.push({
      opensAt: rule.opensAt,
      texte: `${heureLisible(rule.opensAt)} – ${heureLisible(rule.closesAt)}`,
    })
    parJour.set(rule.weekday, plages)
  }

  const jours = [...parJour.entries()]
    .map(([weekday, plages]) => ({
      weekday,
      // Tri sur l'heure brute, jamais sur le texte affiché : « 14h00 »
      // précéderait « 8h00 » dans l'ordre alphabétique.
      horaires: [...plages]
        .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
        .map((plage) => plage.texte)
        .join(' et '),
    }))
    .sort((a, b) => a.weekday - b.weekday)

  // Regroupement des jours consécutifs qui partagent les mêmes horaires.
  const groupes: { premier: number; dernier: number; horaires: string }[] = []
  for (const jour of jours) {
    const courant = groupes[groupes.length - 1]
    if (courant && courant.horaires === jour.horaires && courant.dernier === jour.weekday - 1) {
      courant.dernier = jour.weekday
      continue
    }
    groupes.push({ premier: jour.weekday, dernier: jour.weekday, horaires: jour.horaires })
  }

  return groupes
    .map(({ premier, dernier, horaires }) => {
      const nom = (weekday: number) => JOURS[weekday - 1]
      if (premier === dernier) return `Le ${nom(premier)}, ${horaires}`
      if (dernier === premier + 1) return `Le ${nom(premier)} et le ${nom(dernier)}, ${horaires}`
      return `Du ${nom(premier)} au ${nom(dernier)}, ${horaires}`
    })
    .join(' · ')
}

/** Une plage d'ouverture sans sa ressource : ce qui se copie d'un porteur à l'autre. */
export type OpeningRange = { weekday: number; opensAt: string; closesAt: string }

/** Les horaires à poser sur une ressource qui n'en a pas encore. */
export type CopiePlan = { resourceId: string; ranges: OpeningRange[] }

/**
 * Horaires du centre, débarrassés de leur porteur et dédoublonnés.
 *
 * Sert de modèle : ce sont ces plages que reçoit une ressource qui passe à ses
 * horaires propres, ou qui vient d'être déclarée.
 */
export function centreRanges(rules: readonly OpeningRule[]): OpeningRange[] {
  const vues = new Set<string>()
  const ranges: OpeningRange[] = []

  for (const rule of rules) {
    if (rule.resourceId !== null) continue
    // L'unicité en base porte sur (jour, heure d'ouverture) : le dédoublonnage
    // suit la même clé, sinon la copie viole l'index au lieu d'échouer ici.
    const cle = `${rule.weekday}@${rule.opensAt}`
    if (vues.has(cle)) continue
    vues.add(cle)
    ranges.push({ weekday: rule.weekday, opensAt: rule.opensAt, closesAt: rule.closesAt })
  }

  return ranges.sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt))
}

/**
 * Quelles ressources doivent recevoir une copie des horaires du centre.
 *
 * Une ressource qui a déjà ses propres plages n'est **jamais** touchée : ses
 * horaires sont une saisie délibérée, les écraser reviendrait à annuler le
 * travail de quelqu'un. La copie ne comble que le vide.
 *
 * Un centre sans horaires ne donne rien à copier. On préfère laisser la
 * ressource sans règle — donc fermée, visiblement — plutôt qu'inventer une
 * amplitude par défaut : c'est exactement le repli en dur que l'ADR 010 a
 * retiré du code.
 */
export function planCopieHoraires(
  rules: readonly OpeningRule[],
  resourceIds: readonly string[],
): CopiePlan[] {
  const modele = centreRanges(rules)
  if (modele.length === 0) return []

  const deja = new Set(
    rules.filter((rule) => rule.resourceId !== null).map((rule) => rule.resourceId as string),
  )

  return resourceIds
    .filter((resourceId) => !deja.has(resourceId))
    .map((resourceId) => ({ resourceId, ranges: modele }))
}
