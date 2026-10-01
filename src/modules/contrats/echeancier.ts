import type { ProrataRule } from '../../db/tenants.ts'
import { lineNetAmountCents } from '../facturation/montants.ts'
import type { BillingPeriod } from './schema.ts'

/**
 * Échéancier d'un contrat : quelles périodes sont dues, et pour combien.
 *
 * Tout est en dates de calendrier, jamais en instants : une période de
 * facturation va « du 1er au 31 mars », ce qui ne dépend d'aucun fuseau. Les
 * calculs passent par `Date.UTC`, qui sert ici de simple arithmétique de
 * calendrier.
 *
 * Trois règles, qui sont des choix de gestion et non des évidences :
 *
 * 1. **Périodes alignées sur le calendrier** (ADR 006) — un contrat mensuel est
 *    facturé par mois civil, pas par mois anniversaire. Un contrat qui commence
 *    le 10 mars donne une première période du 10 au 31 mars.
 * 2. **Prorata d'une période partielle selon la règle du centre**
 *    (`tenants.prorata_rule`, ADR 023) : jours réels, base 30, ou aucun.
 * 3. **Versions de prix** (ADR 025) — chaque période est découpée aux dates
 *    d'effet des avenants signés, chaque morceau facturé aux lignes de sa
 *    version (remises comprises), ou à son montant pour une version sans
 *    ligne.
 *
 * Le montant de chaque morceau est calculé par `lineNetAmountCents`, jumeau de
 * la règle d'arrondi de la base : l'échéancier, le contrat et la facture
 * tombent au même centime.
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

/** Nombre de mois d'une période de facturation. */
function periodMonths(period: BillingPeriod): number {
  return period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12
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
  const year = Number(start.slice(0, 4))
  const month = Number(start.slice(5, 7))
  // Le jour 0 du mois suivant est le dernier jour du mois courant, quelle que
  // soit sa longueur et sans table d'années bissextiles à tenir.
  return toIso(Date.UTC(year, month - 1 + periodMonths(period), 0))
}

/** Dernier jour du mois de cette date. */
function lastDayOfMonth(isoDate: string): string {
  return toIso(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), 0))
}

/**
 * Jour d'une date en base 30 : le 31 n'existe pas, et le dernier jour d'un
 * mois compte comme le 30 (fin février comprise).
 */
function thirtyDayOfMonth(isoDate: string): number {
  if (isoDate === lastDayOfMonth(isoDate)) return 30
  return Math.min(Number(isoDate.slice(8, 10)), 30)
}

/**
 * Jours couverts en base 30 (convention 30/360) : somme, mois par mois, des
 * jours comptés ainsi. Du 10 au 31 mars : 21 ; du 1er au 28 février 2026 : 30.
 */
export function thirtyDayCount(startsOn: string, endsOn: string): number {
  let total = 0
  let cursor = startsOn
  for (let guard = 0; guard < 1200 && cursor <= endsOn; guard += 1) {
    const monthEnd = lastDayOfMonth(cursor)
    const last = min(monthEnd, endsOn)
    const from = cursor === startsOn ? thirtyDayOfMonth(cursor) : 1
    const to = last === monthEnd ? 30 : thirtyDayOfMonth(last)
    total += Math.max(0, to - from + 1)
    cursor = addDays(monthEnd, 1)
  }
  return total
}

/** Fraction de prorata d'un morceau de période : porté tel quel sur la ligne de facture. */
export type ProrataFraction = { numerator: number; denominator: number }

/**
 * Prorata d'un morceau `[startsOn, endsOn]` de la période civile
 * `[civilStart, civilEnd]`, selon la règle du centre (ADR 023) :
 *
 * - `calendar_days` : jours couverts sur jours réels de la période, bornes
 *   comprises. Du 10 au 31 mars : 22/31 ;
 * - `thirty_day_month` : base 30 — numérateur compté par `thirtyDayCount`,
 *   dénominateur 30, 90 ou 360 selon la période. Du 10 au 31 mars : 21/30 ;
 * - `none` : 1/1, la période entamée est due en entier.
 *
 * Une période entière rend une fraction égale à 1 (numérateur = dénominateur).
 */
export function prorataFraction(
  rule: ProrataRule,
  piece: { startsOn: string; endsOn: string },
  civil: { startsOn: string; endsOn: string; period: BillingPeriod },
): ProrataFraction {
  if (rule === 'none') return { numerator: 1, denominator: 1 }
  if (rule === 'thirty_day_month') {
    return {
      numerator: thirtyDayCount(piece.startsOn, piece.endsOn),
      denominator: 30 * periodMonths(civil.period),
    }
  }
  return {
    numerator: daysInclusive(piece.startsOn, piece.endsOn),
    denominator: daysInclusive(civil.startsOn, civil.endsOn),
  }
}

/** Ligne d'une version de contrat (`contract_lines`), telle que l'échéancier la facture. */
export type ScheduleLine = {
  quantity: number
  unitPriceCents: number
  discountBp?: number | null
  discountAmountCents?: number | null
  /** Faux : ligne ponctuelle (frais de dossier), due une fois, au premier jour de sa version. */
  isRecurring: boolean
}

/**
 * Version de prix d'un contrat (`contract_price_versions`, ADR 025) : la
 * version initiale, puis une par avenant signé qui change le prix.
 */
export type ScheduleVersion = {
  /** Nul pour la version initiale. */
  amendmentNumber: number | null
  startsOn: string
  /** Nul : jusqu'au dernier jour du contrat. */
  endsOn: string | null
  /** Montant par période d'une version sans ligne. */
  amountCents: number
  /** Lignes vivantes de la version ; vide : la version se facture à `amountCents`. */
  lines: readonly ScheduleLine[]
}

export type ScheduledPeriod = {
  startsOn: string
  endsOn: string
  /**
   * Faux quand le morceau ne couvre qu'une partie de la période civile. Sans
   * prorata (`none`), une période partielle reste due en entier : `full` est
   * faux, la fraction vaut 1.
   */
  full: boolean
  amountCents: number
  /** Fraction appliquée aux lignes récurrentes : `numerator / denominator`. */
  prorata: ProrataFraction
  /** Version facturée : nul pour la version initiale, sinon le numéro de l'avenant. */
  amendmentNumber: number | null
  /** Part des lignes ponctuelles dans `amountCents` (frais de dossier), sans prorata. */
  oneOffCents: number
}

export type ScheduledContract = {
  startsOn: string
  endsOn?: string | null
  terminatedOn?: string | null
  billingPeriod: BillingPeriod
  amountCents: number
}

export type ScheduleOptions = {
  /** Règle de prorata du centre ; `calendar_days` par défaut (ADR 006). */
  prorataRule?: ProrataRule
  /**
   * Versions de prix, dans l'ordre. Absentes : une seule version, le montant
   * du contrat sur toute sa durée — le cas d'un contrat sans avenant ni ligne.
   */
  versions?: readonly ScheduleVersion[]
}

/** Dernier jour facturable : le plus tôt du terme, de la résiliation et de `until`. */
function lastBillableDay(contract: ScheduledContract, until: string): string {
  return [contract.endsOn, contract.terminatedOn]
    .filter((date): date is string => Boolean(date))
    .reduce((earliest, date) => min(earliest, date), until)
}

/** Montant d'un morceau de période facturé à une version. */
function pieceAmount(
  version: ScheduleVersion,
  prorata: ProrataFraction,
  firstPieceOfVersion: boolean,
): { amountCents: number; oneOffCents: number } {
  if (version.lines.length === 0) {
    return {
      amountCents: lineNetAmountCents({
        quantity: 1,
        unitPriceCents: version.amountCents,
        prorataNumerator: prorata.numerator,
        prorataDenominator: prorata.denominator,
      }),
      oneOffCents: 0,
    }
  }
  let recurring = 0
  let oneOff = 0
  for (const line of version.lines) {
    if (line.isRecurring) {
      // Une ligne, un arrondi : comme la ligne de facture qui la reprendra.
      recurring += lineNetAmountCents({
        ...line,
        prorataNumerator: prorata.numerator,
        prorataDenominator: prorata.denominator,
      })
    } else if (firstPieceOfVersion) {
      oneOff += lineNetAmountCents(line)
    }
  }
  return { amountCents: recurring + oneOff, oneOffCents: oneOff }
}

/**
 * Périodes dues entre le début du contrat et `until` inclus.
 *
 * `until` borne la génération : un contrat à durée indéterminée n'a pas de fin,
 * et l'appelant décide jusqu'où il veut regarder — l'année en cours pour un
 * écran, la période suivante pour une facturation, la fin de l'engagement.
 *
 * Une résiliation l'emporte sur le terme prévu : un contrat résilié le 15 avril
 * ne doit rien après le 15 avril, même si son échéance était en décembre.
 *
 * Une période civile qui voit un avenant prendre effet est coupée en deux
 * morceaux, chacun au prorata de ses jours et au prix de sa version. Sans
 * prorata (`none`), la période est due en entier au prix de la version en
 * vigueur à son premier jour : l'avenant s'applique à la période suivante.
 */
export function billingSchedule(
  contract: ScheduledContract,
  until: string,
  options: ScheduleOptions = {},
): ScheduledPeriod[] {
  const rule = options.prorataRule ?? 'calendar_days'
  const lastDay = lastBillableDay(contract, until)
  if (lastDay < contract.startsOn) return []

  const versions: readonly ScheduleVersion[] = options.versions?.length
    ? options.versions
    : [
        {
          amendmentNumber: null,
          startsOn: contract.startsOn,
          endsOn: null,
          amountCents: contract.amountCents,
          lines: [],
        },
      ]

  const periods: ScheduledPeriod[] = []
  const versionsStarted = new Set<ScheduleVersion>()
  let cursor = periodStart(contract.startsOn, contract.billingPeriod)

  // La borne de sécurité couvre un siècle de mensualités : elle ne se déclenche
  // que sur un `until` aberrant, jamais sur un contrat réel.
  for (let guard = 0; guard < 1200; guard += 1) {
    const civil = {
      startsOn: cursor,
      endsOn: periodEnd(cursor, contract.billingPeriod),
      period: contract.billingPeriod,
    }
    const spanStart = max(civil.startsOn, contract.startsOn)
    const spanEnd = min(civil.endsOn, lastDay)
    if (spanStart > spanEnd) break

    for (const version of versions) {
      const startsOn = max(spanStart, version.startsOn)
      const endsOn = version.endsOn ? min(spanEnd, version.endsOn) : spanEnd
      if (startsOn > endsOn) continue
      // Sans prorata, seul le morceau qui ouvre la période la facture.
      if (rule === 'none' && startsOn !== spanStart) continue

      const prorata = prorataFraction(rule, { startsOn, endsOn }, civil)
      const firstPieceOfVersion = !versionsStarted.has(version)
      versionsStarted.add(version)
      const { amountCents, oneOffCents } = pieceAmount(version, prorata, firstPieceOfVersion)
      periods.push({
        startsOn,
        endsOn,
        full: startsOn === civil.startsOn && endsOn === civil.endsOn,
        amountCents,
        prorata,
        amendmentNumber: version.amendmentNumber,
        oneOffCents,
      })
    }

    if (civil.endsOn >= lastDay) break
    cursor = addDays(civil.endsOn, 1)
  }

  return periods
}

/** Total dû sur l'échéancier, en centimes. */
export function scheduleTotalCents(periods: readonly ScheduledPeriod[]): number {
  return periods.reduce((total, period) => total + period.amountCents, 0)
}

/**
 * Ce que l'engagement garantit (R10, ADR 023) : les périodes dues du début du
 * contrat à la fin de son engagement (`commitment_ends_on`), et leur total.
 * Rien sans engagement.
 */
export function commitmentSchedule(
  contract: ScheduledContract & { commitmentEndsOn?: string | null },
  options: ScheduleOptions = {},
): { endsOn: string; periods: ScheduledPeriod[]; totalCents: number } | undefined {
  if (!contract.commitmentEndsOn) return undefined
  const periods = billingSchedule(contract, contract.commitmentEndsOn, options)
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
 * Premier dernier jour possible sans rompre l'engagement — jumeau de
 * `contract_earliest_end_on()` (ADR 023) : le plus tardif du terme du préavis
 * et de la fin d'engagement. La base ne refuse pas une résiliation plus
 * précoce, accord entre le centre et son client : l'écran la signale.
 */
export function earliestEndOn(
  requestedOn: string,
  noticeDays: number,
  commitmentEndsOn?: string | null,
): string {
  const notice = noticeEndsOn(requestedOn, noticeDays)
  return commitmentEndsOn ? max(notice, commitmentEndsOn) : notice
}
