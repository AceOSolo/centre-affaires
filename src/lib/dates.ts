/**
 * Traduction entre l'heure murale d'un centre et les instants UTC de la base
 * (décision 4).
 *
 * Le staff saisit « le 25 octobre à 9h00 » sans penser au fuseau. La base ne
 * connaît que des instants. La conversion ne peut se faire ni avec le fuseau du
 * serveur — Vercel tourne en UTC, le poste du staff en Europe/Paris — ni avec un
 * décalage fixe, qui change deux fois par an.
 *
 * Tout passe par `Intl`, donc par la base de fuseaux du système : aucune
 * dépendance et aucune table d'heures d'été à tenir à jour.
 */

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `hour12: false` produit l'heure 24 à minuit sur certains runtimes ;
      // `h23` donne toujours 00.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Décalage du fuseau à cet instant précis, en millisecondes. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  const wallAsIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  )
  return wallAsIfUtc - instant.getTime()
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * Instant UTC correspondant à une heure murale du centre — le format rendu par
 * un `<input type="datetime-local">`, « 2026-10-25T09:00 ».
 *
 * Deux passes : le décalage dépend de l'instant et l'instant dépend du décalage.
 * La première estimation suffit partout sauf autour d'un changement d'heure, où
 * la seconde corrige.
 *
 * Aux deux bornes du changement d'heure, l'heure murale ne désigne pas un
 * instant unique :
 * - heure inexistante (saut de printemps) : décalée vers l'avant, 2h30 devient
 *   3h30 ;
 * - heure en double (retour d'automne) : la seconde occurrence est retenue.
 *
 * Ces deux cas tombent entre 2h et 3h du matin, hors des horaires d'un centre
 * d'affaires ; ce qui compte est que le verdict soit déterminé, pas arbitré au
 * hasard d'un fuseau serveur.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): Date {
  const match = WALL_CLOCK.exec(wallClock.trim())
  if (!match) {
    throw new Error(`Heure murale illisible : « ${wallClock} »`)
  }
  const [, year, month, day, hour, minute, second] = match
  const wallAsIfUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second ? Number(second) : 0,
  )
  const firstGuess = new Date(wallAsIfUtc - offsetAt(new Date(wallAsIfUtc), timeZone))
  return new Date(wallAsIfUtc - offsetAt(firstGuess, timeZone))
}

/** Heure murale du centre, au format attendu par `<input type="datetime-local">`. */
export function toWallClock(instant: Date, timeZone: string): string {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}`
}

/** Jour du centre au format ISO « 2026-10-25 », pour les URL et les `<input type="date">`. */
export function toIsoDate(instant: Date, timeZone: string): string {
  return toWallClock(instant, timeZone).slice(0, 10)
}

/** Aujourd'hui pour le centre, qui n'est pas forcément aujourd'hui pour le serveur. */
export function todayIsoDate(timeZone: string, now: Date = new Date()): string {
  return toIsoDate(now, timeZone)
}

/** Décale un jour ISO sans passer par un fuseau : arithmétique de calendrier pure. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * Bornes UTC d'une journée du centre, en `[)` comme les réservations.
 *
 * La durée n'est pas toujours de 24 heures : 23 au passage à l'heure d'été, 25
 * au retour. Calculer la borne haute en ajoutant 24 heures ferait disparaître —
 * ou dupliquer — une heure de planning deux fois par an.
 */
export function dayRangeUtc(isoDate: string, timeZone: string): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: wallClockToUtc(`${isoDate}T00:00`, timeZone),
    endsAt: wallClockToUtc(`${addDaysToIsoDate(isoDate, 1)}T00:00`, timeZone),
  }
}

/** « 09:30 » dans le fuseau du centre. */
export function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant)
}

/** « dimanche 25 octobre 2026 ». */
export function formatLongDate(isoDate: string, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(wallClockToUtc(`${isoDate}T12:00`, timeZone))
}

/** « 1 h 30 », « 45 min » — durée lisible d'une réservation. */
export function formatDuration(startsAt: Date, endsAt: Date): string {
  return formatMinutes(Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000))
}

/** Même mise en forme, à partir d'un nombre de minutes déjà calculé. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  if (rest === 0) return `${hours} h`
  return `${hours} h ${String(rest).padStart(2, '0')}`
}
