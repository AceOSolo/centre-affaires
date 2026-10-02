import type { ProrataRule } from '../../db/tenants.ts'
import { lineNetAmountCents, type LineAmountInput } from '../facturation/montants.ts'
import type { BillingPeriod } from './schema.ts'

/**
 * Échéancier d'un contrat : quelles périodes sont dues, et pour combien.
 *
 * Tout est en dates de calendrier, jamais en instants : une période de
 * facturation va « du 1er au 31 mars », ce qui ne dépend d'aucun fuseau. Les
 * calculs passent par `Date.UTC`, qui sert ici de simple arithmétique de
 * calendrier.
 *
 * Conventions, qui sont des choix de gestion et non des évidences :
 *
 * 1. **Périodes alignées sur le calendrier** (ADR 006) — un contrat mensuel est
 *    facturé par mois civil, pas par mois anniversaire. Un contrat qui commence
 *    le 10 mars donne une première période du 10 au 31 mars.
 * 2. **Prorata d'une période partielle selon la règle du centre**
 *    (`tenants.prorata_rule`, ADR 023) : jours réels par défaut, mois de
 *    30 jours, ou pas de prorata.
 * 3. **Une période se coupe aux dates d'effet des avenants** (ADR 025) :
 *    chaque morceau est dû au prix de sa version, au prorata de la règle.
 *
 * Le montant d'un morceau suit la règle d'arrondi unique de la base
 * (`lineNetAmountCents`, jumelle de `line_net_amount_cents`) : ligne à ligne
 * quand la version a des lignes, sur son montant sinon. L'échéancier tombe
 * ainsi au centime de la facture qui reprendra ces lignes.
 */

const MS_PER_DAY = 86_400_000

const toUtc = (isoDate: string): number =>
  Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)))

const toIso = (utc: number): string => new Date(utc).toISOString().slice(0, 10)

/** Les dates ISO se comparent comme des chaînes : le format est ordonné. */
const min = (a: string, b: string) => (a <= b ? a : b)
const max = (a: string, b: string) => (a >= b ? a : b)

/** Nombre de jours d'une période, bornes comprises. Du 1er au 31 mars : 31. */
export function daysInclusive(startsOn: string, endsOn: string): number {
  return Math.round((toUtc(endsOn) - toUtc(startsOn)) / MS_PER_DAY) + 1
}

/** Décale une date de calendrier d'un nombre de jours. */
export function addDays(isoDate: string, days: number): string {
  return toIso(toUtc(isoDate) + days * MS_PER_DAY)
}

/** Premier mois de la période qui contient ce mois : 1, 4, 7 ou 10 au trimestre. */
function periodStartMonth(month: number, period: BillingPeriod): number {
  if (period === 'monthly') return month
  if (period === 'quarterly') return month - ((month - 1) % 3)
  return 1
}

/** Premier jour de la période de facturation qui contient cette date. */
export function periodStart(isoDate: string, period: BillingPeriod): string {
  const year = Number(isoDate.slice(0, 4))
  const month = periodStartMonth(Number(isoDate.slice(5, 7)), period)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** Dernier jour de la période de facturation qui contient cette date. */
export function periodEnd(isoDate: string, period: BillingPeriod): string {
  const start = periodStart(isoDate, period)
  const months = period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12
  const year = Number(start.slice(0, 4))
  const month = Number(start.slice(5, 7))
  // Le jour 0 du mois suivant est le dernier jour du mois courant, quelle que
  // soit sa longueur et sans table d'années bissextiles à tenir.
  return toIso(Date.UTC(year, month - 1 + months, 0))
}

/**
 * Montant dû pour une période partielle.
 *
 * Arrondi au centime le plus proche : les montants sont des entiers de centimes
 * (décision 5), et un flottant qui traîne finit par produire une facture à
 * 149,999999 €. Une période entière rend exactement le montant du contrat, sans
 * passer par la division.
 */
export function prorataCents(amountCents: number, coveredDays: number, periodDays: number): number {
  if (periodDays <= 0 || coveredDays <= 0) return 0
  if (coveredDays >= periodDays) return amountCents
  return Math.round((amountCents * coveredDays) / periodDays)
}

export type ScheduledPeriod = {
  startsOn: string
  endsOn: string
  /** Faux quand le contrat ne couvre qu'une partie de la période civile. */
  full: boolean
  amountCents: number
}

export type ScheduledContract = {
  startsOn: string
  endsOn?: string | null
  terminatedOn?: string | null
  billingPeriod: BillingPeriod
  amountCents: number
}

/** Nombre de mois d'une période de facturation : 1, 3 ou 12. */
export function monthsPerPeriod(period: BillingPeriod): number {
  return period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12
}

/** Fraction d'une période due : `numerator / denominator`, jamais un flottant. */
export type ProrataFraction = { numerator: number; denominator: number }

/** Dernier jour du mois de cette date : 28, 29, 30 ou 31. */
function lastDayOfMonth(isoDate: string): number {
  return Number(periodEnd(isoDate, 'monthly').slice(8, 10))
}

/**
 * Jours couverts d'un mois en base 30 (convention 30/360, ADR 023) : chaque
 * mois compte 30 jours, le 31 n'existe pas, et le dernier jour du mois compte
 * comme le 30 — fin février comprise. `startsOn` et `endsOn` sont dans le même
 * mois. Du 10 au 31 mars : 21 ; le 31 seul : 0 ; du 1er au 28 février : 30.
 *
 * Les morceaux d'un même mois s'additionnent toujours à 30 : du 1er au 14
 * février (14), puis du 15 au 28 (16).
 */
function thirtyDayMonthDays(startsOn: string, endsOn: string): number {
  const first = Number(startsOn.slice(8, 10))
  const lastDay = Number(endsOn.slice(8, 10))
  const last = lastDay === lastDayOfMonth(endsOn) ? 30 : Math.min(lastDay, 30)
  return Math.max(0, last - first + 1)
}

/**
 * Fraction due pour les jours `startsOn`–`endsOn` (bornes comprises) de la
 * période civile qui les contient, selon la règle du centre (ADR 023) :
 *
 * - `calendar_days` : jours couverts sur jours réels de la période. Du 10 au
 *   31 mars : 22/31 ;
 * - `thirty_day_month` : somme, mois par mois, des jours comptés en base 30,
 *   sur 30, 90 ou 360. Du 10 au 31 mars : 21/30 ;
 * - `none` : la période entamée est due en entier, 1/1.
 *
 * C'est aussi la fraction à porter sur la ligne de facture
 * (`prorata_numerator`, `prorata_denominator`) : le montant se recalcule par
 * `lineNetAmountCents`, au centime de la base.
 */
export function prorataFraction(
  rule: ProrataRule,
  startsOn: string,
  endsOn: string,
  period: BillingPeriod,
): ProrataFraction {
  if (rule === 'none') return { numerator: 1, denominator: 1 }
  const civilStart = periodStart(startsOn, period)
  const civilEnd = periodEnd(startsOn, period)
  if (rule === 'calendar_days') {
    return {
      numerator: daysInclusive(startsOn, endsOn),
      denominator: daysInclusive(civilStart, civilEnd),
    }
  }
  let numerator = 0
  let month = periodStart(startsOn, 'monthly')
  while (month <= endsOn) {
    const monthEnd = periodEnd(month, 'monthly')
    numerator += thirtyDayMonthDays(max(month, startsOn), min(monthEnd, endsOn))
    month = addDays(monthEnd, 1)
  }
  return { numerator, denominator: 30 * monthsPerPeriod(period) }
}

/** Une ligne de contrat, telle que l'échéancier la facture. */
export type ScheduleLine = LineAmountInput & {
  /** Faux : ligne ponctuelle (frais de dossier), due une fois. */
  isRecurring: boolean
}

/**
 * Une version de prix du contrat (`contract_price_versions`, ADR 025) : la
 * version initiale (`amendmentId` nul), puis chaque avenant signé qui change
 * le prix, de sa date d'effet à la veille de la suivante.
 */
export type ScheduleVersion = {
  amendmentId: string | null
  amendmentNumber: number | null
  startsOn: string
  /** Nul : jusqu'au dernier jour du contrat, ou sans terme. */
  endsOn: string | null
  /** Montant par période d'une version sans ligne récurrente. */
  amountCents: number
  /** Lignes vivantes de la version ; vide : la version se facture d'un montant. */
  lines?: readonly ScheduleLine[]
}

/** Le morceau d'une période dû au prix d'une version. */
export type SchedulePiece = ProrataFraction & {
  startsOn: string
  endsOn: string
  amendmentId: string | null
  amendmentNumber: number | null
  /** Récurrent du morceau, au prorata. */
  amountCents: number
  /** Lignes ponctuelles de la version, dues sur son premier jour. */
  oneOffCents: number
}

export type VersionedPeriod = ScheduledPeriod & { pieces: SchedulePiece[] }

/**
 * Récurrent dû pour une fraction de période : ligne à ligne si la version a
 * des lignes récurrentes, sur son montant sinon (`contract_version_lines_amount`
 * ne compte que les récurrentes).
 */
function versionAmountCents(version: ScheduleVersion, fraction: ProrataFraction): number {
  if (fraction.numerator === 0) return 0
  const prorata = {
    prorataNumerator: fraction.numerator,
    prorataDenominator: fraction.denominator,
  }
  const recurring = (version.lines ?? []).filter((line) => line.isRecurring)
  if (recurring.length === 0) {
    return lineNetAmountCents({ quantity: 1, unitPriceCents: version.amountCents, ...prorata })
  }
  return recurring.reduce((total, line) => total + lineNetAmountCents({ ...line, ...prorata }), 0)
}

function oneOffCents(version: ScheduleVersion): number {
  return (version.lines ?? [])
    .filter((line) => !line.isRecurring)
    .reduce((total, line) => total + lineNetAmountCents(line), 0)
}

/**
 * Échéancier versionné : les périodes dues entre le début du contrat et
 * `until` inclus, chacune coupée aux dates d'effet de ses versions de prix
 * (ADR 025), chaque morceau au prorata de la règle du centre (ADR 023).
 *
 * - Sans version, le contrat se facture de son seul montant.
 * - Une ligne ponctuelle est due une fois, dans la période qui contient le
 *   premier jour de sa version — la période que la facture lui donne.
 * - En règle `none`, une période entamée est due en entier au prix de la
 *   version en vigueur sur son premier jour couvert ; une version qui prend
 *   effet en cours de période ne compte qu'à partir de la période suivante
 *   (fraction 0/1), sans quoi la période serait due deux fois.
 *
 * `until` borne la génération : un contrat à durée indéterminée n'a pas de fin,
 * et l'appelant décide jusqu'où il veut regarder — l'année en cours pour un
 * écran, la période suivante pour une facturation. Une résiliation l'emporte
 * sur le terme prévu : un contrat résilié le 15 avril ne doit rien après.
 */
export function contractSchedule(
  contract: ScheduledContract,
  versions: readonly ScheduleVersion[],
  until: string,
  rule: ProrataRule = 'calendar_days',
): VersionedPeriod[] {
  const bounds = [contract.endsOn, contract.terminatedOn].filter(
    (date): date is string => Boolean(date),
  )
  const lastDay = bounds.reduce((earliest, date) => min(earliest, date), until)
  if (lastDay < contract.startsOn) return []

  const ordered: readonly ScheduleVersion[] =
    versions.length > 0
      ? [...versions].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))
      : [
          {
            amendmentId: null,
            amendmentNumber: null,
            startsOn: contract.startsOn,
            endsOn: null,
            amountCents: contract.amountCents,
          },
        ]

  const periods: VersionedPeriod[] = []
  let cursor = periodStart(contract.startsOn, contract.billingPeriod)

  // La borne de sécurité couvre un siècle de mensualités : elle ne se déclenche
  // que sur un `until` aberrant, jamais sur un contrat réel.
  for (let guard = 0; guard < 1200; guard += 1) {
    const civilStart = cursor
    const civilEnd = periodEnd(cursor, contract.billingPeriod)

    const startsOn = max(civilStart, contract.startsOn)
    const endsOn = min(civilEnd, lastDay)
    if (startsOn > endsOn) break

    const pieces: SchedulePiece[] = []
    for (const version of ordered) {
      const pieceStart = max(version.startsOn, startsOn)
      const pieceEnd = min(version.endsOn ?? endsOn, endsOn)
      if (pieceStart > pieceEnd) continue
      const fraction: ProrataFraction =
        rule === 'none'
          ? { numerator: pieces.length === 0 ? 1 : 0, denominator: 1 }
          : prorataFraction(rule, pieceStart, pieceEnd, contract.billingPeriod)
      pieces.push({
        startsOn: pieceStart,
        endsOn: pieceEnd,
        amendmentId: version.amendmentId,
        amendmentNumber: version.amendmentNumber,
        ...fraction,
        amountCents: versionAmountCents(version, fraction),
        oneOffCents:
          version.startsOn >= startsOn && version.startsOn <= endsOn ? oneOffCents(version) : 0,
      })
    }

    periods.push({
      startsOn,
      endsOn,
      full: daysInclusive(startsOn, endsOn) === daysInclusive(civilStart, civilEnd),
      amountCents: pieces.reduce((total, piece) => total + piece.amountCents + piece.oneOffCents, 0),
      pieces,
    })

    if (civilEnd >= lastDay) break
    cursor = addDays(civilEnd, 1)
  }

  return periods
}

/**
 * Périodes dues entre le début du contrat et `until` inclus, au seul montant
 * du contrat : `contractSchedule` sans version ni détail des morceaux.
 */
export function billingSchedule(
  contract: ScheduledContract,
  until: string,
  rule: ProrataRule = 'calendar_days',
): ScheduledPeriod[] {
  return contractSchedule(contract, [], until, rule).map(
    ({ startsOn, endsOn, full, amountCents }) => ({ startsOn, endsOn, full, amountCents }),
  )
}

/** Total dû sur l'échéancier, en centimes. */
export function scheduleTotalCents(periods: readonly ScheduledPeriod[]): number {
  return periods.reduce((total, period) => total + period.amountCents, 0)
}

/**
 * Ce que l'engagement garantit (R10, ADR 023) : les périodes dues du début du
 * contrat à la fin de son engagement (`commitment_ends_on`), à ses versions de
 * prix et selon la règle de prorata du centre, et leur total. Rien sans
 * engagement.
 */
export function commitmentSchedule(
  contract: ScheduledContract & { commitmentEndsOn?: string | null },
  versions: readonly ScheduleVersion[] = [],
  rule: ProrataRule = 'calendar_days',
): { endsOn: string; periods: VersionedPeriod[]; totalCents: number } | undefined {
  if (!contract.commitmentEndsOn) return undefined
  const periods = contractSchedule(contract, versions, contract.commitmentEndsOn, rule)
  return { endsOn: contract.commitmentEndsOn, periods, totalCents: scheduleTotalCents(periods) }
}

/**
 * Dernier jour du contrat si le préavis était déposé à cette date.
 *
 * Le préavis court à partir du jour de la demande, celui-ci compris : 90 jours
 * déposés le 1er mars mènent au 29 mai inclus. Sans préavis, le contrat
 * s'arrête le jour même.
 */
export function noticeEndsOn(requestedOn: string, noticeDays: number): string {
  return addDays(requestedOn, Math.max(0, noticeDays - 1))
}

/**
 * Ajoute des mois à une date de calendrier comme Postgres (`date + interval`) :
 * le jour est ramené au dernier du mois quand il n'y existe pas. Le 31 janvier
 * plus un mois donne le 28 février (le 29 en année bissextile).
 */
export function addMonths(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7)) - 1 + months
  const day = Number(isoDate.slice(8, 10))
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return toIso(Date.UTC(year, month, Math.min(day, lastDay)))
}

/**
 * Dernier jour d'engagement, de date à date (ADR 023) : premier jour plus la
 * durée, moins un jour. Du 10 mars, douze mois : le 9 mars suivant. Jumelle de
 * la colonne générée `contracts.commitment_ends_on`, pour l'annoncer avant
 * l'écriture. Nul sans engagement.
 */
export function commitmentEndsOn(
  startsOn: string,
  months: number | null | undefined,
): string | null {
  if (!months) return null
  return addDays(addMonths(startsOn, months), -1)
}

/**
 * Premier terme possible si le préavis est donné ce jour-là — jumelle de
 * `contract_earliest_end_on` (ADR 023) : le plus tardif du terme du préavis et
 * de la fin d'engagement. Une résiliation plus tôt reste possible d'un commun
 * accord : l'écran la signale, la base ne la refuse pas.
 */
export function earliestEndOn(
  noticeOn: string,
  noticeDays: number,
  commitmentEnd: string | null | undefined,
): string {
  const notice = noticeEndsOn(noticeOn, noticeDays)
  return commitmentEnd ? max(notice, commitmentEnd) : notice
}
