import type { ProrataRule } from '../../db/tenants.ts'
import type { ScheduleVersion, ScheduledContract } from '../contrats/echeancier.ts'
import type { BookableUnit, QuoteDiscount, QuotePlan, QuoteRules } from './devis.ts'
import { DEFAULT_QUANTITY_RULES } from './tarifs.ts'

/**
 * Jeu de cas tarifaires figé (R10, décision D5 de l'ADR 016).
 *
 * **Statut : à valider par l'exploitation.** Chaque cas dit ce que le moteur
 * facture, au centime. Le centre relit la liste, confirme ou corrige le montant
 * attendu ; un montant corrigé fait échouer `cas-tarifaires.test.ts` tant que la
 * règle n'a pas été changée — et c'est le but : une règle tarifaire ne bouge
 * pas sans qu'un cas écrit le dise.
 *
 * Les montants sont en centimes (décision 5), hors taxes sauf mention TTC.
 * Les créneaux sont en heure murale du centre (Europe/Paris).
 */
export const STATUT_DES_CAS = 'à valider par l’exploitation' as const

/**
 * La grille publique réelle du centre, recopiée de `infra/catalogue.mjs`
 * (ADR 009) : salles 90 € la demi-journée et 130 € la journée, poste de bureau
 * 7 € la demi-journée, boîte aux lettres 30 € par mois.
 */
export const GRILLE_REELLE: QuotePlan = {
  id: 'grille-reelle',
  name: 'Tarifs publics 2026',
  currency: 'EUR',
  validFrom: null,
  validTo: null,
  items: [
    { id: 'salle-demi-journee', resourceType: 'salle', resourceId: null, unit: 'half_day', amountCents: 9_000 },
    { id: 'salle-journee', resourceType: 'salle', resourceId: null, unit: 'day', amountCents: 13_000 },
    { id: 'bureau-demi-journee', resourceType: 'bureau', resourceId: null, unit: 'half_day', amountCents: 700 },
    { id: 'boite-mois', resourceType: 'boite_aux_lettres', resourceId: null, unit: 'month', amountCents: 3_000 },
  ],
}

/**
 * Le centre ne publie ni prix à l'heure ni prix à la semaine. Les deux prix
 * ci-dessous sont des **hypothèses de travail**, posées pour éprouver ces
 * unités (R08) : à remplacer par les prix réels, ou à retirer.
 */
export const GRILLE_AVEC_HYPOTHESES: QuotePlan = {
  ...GRILLE_REELLE,
  id: 'grille-hypotheses',
  name: 'Tarifs publics 2026 + hypothèses heure et semaine',
  items: [
    ...GRILLE_REELLE.items,
    { id: 'salle-heure', resourceType: 'salle', resourceId: null, unit: 'hour', amountCents: 2_500 },
    { id: 'bureau-semaine', resourceType: 'bureau', resourceId: null, unit: 'week', amountCents: 15_000 },
  ],
}

/** Règles du centre par défaut (colonnes de `tenants`, ADR 023). */
export const REGLES_PAR_DEFAUT: QuoteRules & { prorataRule: ProrataRule } = {
  ...DEFAULT_QUANTITY_RULES,
  defaultVatRateBp: 2_000,
  prorataRule: 'calendar_days',
}

export type CasReservation = {
  id: string
  /** Ce que le cas éprouve, en une phrase. */
  libelle: string
  ressource: { id: string; resourceType: 'salle' | 'bureau' | 'boite_aux_lettres' }
  /** Heure murale du centre : « 2026-10-06T09:00 ». */
  debut: string
  fin: string
  grille?: QuotePlan
  regles?: Partial<QuoteRules>
  remise?: QuoteDiscount
  attendu: {
    unit: BookableUnit
    quantity: number
    netCents: number
    vatCents: number
    totalCents: number
  }
  /** Question à trancher par l'exploitation, quand le cas en soulève une. */
  question?: string
}

const SALLE = { id: 'salle-mont-blanc', resourceType: 'salle' as const }
const POSTE = { id: 'bureau-03-p1', resourceType: 'bureau' as const }

export const casReservations: readonly CasReservation[] = [
  {
    id: 'demi-journee',
    libelle: 'Salle, matinée de 9 h à 13 h : une demi-journée',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T13:00',
    attendu: { unit: 'half_day', quantity: 1, netCents: 9_000, vatCents: 1_800, totalCents: 10_800 },
  },
  {
    id: 'jour',
    libelle: 'Salle, journée de 9 h à 18 h : la journée, moins chère que trois demi-journées',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T18:00',
    attendu: { unit: 'day', quantity: 1, netCents: 13_000, vatCents: 2_600, totalCents: 15_600 },
  },
  {
    id: 'demi-journee-entamee',
    libelle: 'Salle, de 9 h à 13 h 15 : la demi-journée entamée fait passer à la journée',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T13:15',
    attendu: { unit: 'day', quantity: 1, netCents: 13_000, vatCents: 2_600, totalCents: 15_600 },
    question: 'Un dépassement de quinze minutes doit-il coûter la journée ? Sinon, fixer une tolérance.',
  },
  {
    id: 'tolerance',
    libelle: 'Même créneau avec une tolérance de 15 minutes : une demi-journée',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T13:15',
    regles: { startedUnitToleranceMinutes: 15 },
    attendu: { unit: 'half_day', quantity: 1, netCents: 9_000, vatCents: 1_800, totalCents: 10_800 },
  },
  {
    id: 'heure-grille-reelle',
    libelle: 'Salle, une heure : sans prix à l’heure, une demi-journée est due',
    ressource: SALLE,
    debut: '2026-10-06T10:00',
    fin: '2026-10-06T11:00',
    attendu: { unit: 'half_day', quantity: 1, netCents: 9_000, vatCents: 1_800, totalCents: 10_800 },
    question: 'Le centre loue-t-il ses salles à l’heure ? Si oui, à quel prix ?',
  },
  {
    id: 'heure-hypothese',
    libelle: 'Salle, deux heures, avec un prix hypothétique de 25 € de l’heure',
    ressource: SALLE,
    debut: '2026-10-06T10:00',
    fin: '2026-10-06T12:00',
    grille: GRILLE_AVEC_HYPOTHESES,
    attendu: { unit: 'hour', quantity: 2, netCents: 5_000, vatCents: 1_000, totalCents: 6_000 },
  },
  {
    id: 'heure-entamee',
    libelle: 'Salle, 1 h 10 au prix hypothétique de l’heure : deux heures',
    ressource: SALLE,
    debut: '2026-10-06T10:00',
    fin: '2026-10-06T11:10',
    grille: GRILLE_AVEC_HYPOTHESES,
    attendu: { unit: 'hour', quantity: 2, netCents: 5_000, vatCents: 1_000, totalCents: 6_000 },
  },
  {
    id: 'poste-demi-journee',
    libelle: 'Poste de bureau, matinée de 8 h à 12 h',
    ressource: POSTE,
    debut: '2026-10-06T08:00',
    fin: '2026-10-06T12:00',
    attendu: { unit: 'half_day', quantity: 1, netCents: 700, vatCents: 140, totalCents: 840 },
  },
  {
    id: 'poste-journee',
    libelle: 'Poste de bureau, de 8 h à 18 h : trois demi-journées (pas de prix à la journée)',
    ressource: POSTE,
    debut: '2026-10-06T08:00',
    fin: '2026-10-06T18:00',
    attendu: { unit: 'half_day', quantity: 3, netCents: 2_100, vatCents: 420, totalCents: 2_520 },
    question: 'Un poste à la journée doit-il avoir son propre prix ?',
  },
  {
    id: 'semaine-grille-reelle',
    libelle: 'Poste de bureau, du lundi au samedi minuit : 30 demi-journées sans prix à la semaine',
    ressource: POSTE,
    debut: '2026-10-05T00:00',
    fin: '2026-10-10T00:00',
    attendu: { unit: 'half_day', quantity: 30, netCents: 21_000, vatCents: 4_200, totalCents: 25_200 },
    question: 'Le centre vend-il le poste à la semaine ? Une réservation de plusieurs jours compte ses nuits.',
  },
  {
    id: 'semaine-hypothese',
    libelle: 'Même semaine avec un prix hypothétique de 150 € la semaine',
    ressource: POSTE,
    debut: '2026-10-05T00:00',
    fin: '2026-10-10T00:00',
    grille: GRILLE_AVEC_HYPOTHESES,
    attendu: { unit: 'week', quantity: 1, netCents: 15_000, vatCents: 3_000, totalCents: 18_000 },
  },
  {
    id: 'remise-pourcentage',
    libelle: 'Salle, journée, remise de 10 %',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T18:00',
    remise: { kind: 'percent', basisPoints: 1_000 },
    attendu: { unit: 'day', quantity: 1, netCents: 11_700, vatCents: 2_340, totalCents: 14_040 },
  },
  {
    id: 'remise-montant',
    libelle: 'Salle, demi-journée, remise de 15 €',
    ressource: SALLE,
    debut: '2026-10-06T09:00',
    fin: '2026-10-06T13:00',
    remise: { kind: 'amount', cents: 1_500 },
    attendu: { unit: 'half_day', quantity: 1, netCents: 7_500, vatCents: 1_500, totalCents: 9_000 },
  },
]

export type CasContrat = {
  id: string
  libelle: string
  contrat: ScheduledContract & { commitmentEndsOn?: string | null }
  /** Règle de prorata du centre et versions de prix, comme `contractSchedule` les lit. */
  options: { prorataRule: ProrataRule; versions?: readonly ScheduleVersion[] }
  /** Fin de l'échéancier regardé. */
  jusquAu: string
  attendu: {
    /**
     * Montant HT de chaque échéance, dans l'ordre : un par morceau de période
     * (une période coupée par un avenant en donne deux), frais ponctuels compris.
     */
    echeances: number[]
    totalCents: number
  }
  question?: string
}

/** Domiciliation à 30 € par mois, commencée le 10 mars. */
const DOMICILIATION: ScheduledContract = {
  startsOn: '2026-03-10',
  billingPeriod: 'monthly',
  amountCents: 3_000,
}

export const casContrats: readonly CasContrat[] = [
  {
    id: 'mois',
    libelle: 'Boîte aux lettres à 30 € par mois, mois entier',
    contrat: { ...DOMICILIATION, startsOn: '2026-03-01' },
    options: { prorataRule: 'calendar_days' },
    jusquAu: '2026-03-31',
    attendu: { echeances: [3_000], totalCents: 3_000 },
  },
  {
    id: 'prorata-jours-reels',
    libelle: 'Commencée le 10 mars, prorata en jours réels : 22/31 de mars',
    contrat: DOMICILIATION,
    options: { prorataRule: 'calendar_days' },
    jusquAu: '2026-04-30',
    // 30 € × 22/31 = 21,290… €.
    attendu: { echeances: [2_129, 3_000], totalCents: 5_129 },
  },
  {
    id: 'prorata-base-30',
    libelle: 'Même contrat, prorata en base 30 : 21/30 de mars',
    contrat: DOMICILIATION,
    options: { prorataRule: 'thirty_day_month' },
    jusquAu: '2026-04-30',
    attendu: { echeances: [2_100, 3_000], totalCents: 5_100 },
  },
  {
    id: 'sans-prorata',
    libelle: 'Même contrat, sans prorata : mars est dû en entier',
    contrat: DOMICILIATION,
    options: { prorataRule: 'none' },
    jusquAu: '2026-04-30',
    attendu: { echeances: [3_000, 3_000], totalCents: 6_000 },
  },
  {
    id: 'remise-lignes',
    libelle: 'Bureau à 500 € remisé de 10 % et domiciliation à 30 € remisée de 5 €, frais de dossier de 150 €',
    contrat: { startsOn: '2026-03-10', billingPeriod: 'monthly', amountCents: 0 },
    options: {
      prorataRule: 'calendar_days',
      versions: [
        {
          amendmentId: null,
          amendmentNumber: null,
          startsOn: '2026-03-10',
          endsOn: null,
          amountCents: 0,
          lines: [
            { quantity: 1, unitPriceCents: 50_000, discountBp: 1_000, isRecurring: true },
            { quantity: 1, unitPriceCents: 3_000, discountAmountCents: 500, isRecurring: true },
            { quantity: 1, unitPriceCents: 15_000, isRecurring: false },
          ],
        },
      ],
    },
    jusquAu: '2026-04-30',
    // Mars, 22/31 : 319,35 € + 17,74 € + 150 € de frais ; avril : 450 € + 25 €.
    attendu: { echeances: [48_709, 47_500], totalCents: 96_209 },
    question: 'Une remise en montant (5 €) se proratise-t-elle avec le prix sur une période partielle ?',
  },
  {
    id: 'engagement',
    libelle: 'Domiciliation engagée 12 mois à compter du 10 mars : ce que l’engagement garantit',
    contrat: { ...DOMICILIATION, commitmentEndsOn: '2027-03-09' },
    options: { prorataRule: 'calendar_days' },
    jusquAu: '2027-03-09',
    // 22/31 de mars 2026, onze mois, 9/31 de mars 2027 : douze mois exactement.
    attendu: {
      echeances: [2_129, ...Array.from({ length: 11 }, () => 3_000), 871],
      totalCents: 36_000,
    },
    question: 'L’engagement court-il de date à date (du 10 mars au 9 mars) ?',
  },
  {
    id: 'avenant',
    libelle: 'Bureau à 900 € puis 1 200 € par avenant au 15 mars : mars coupé en deux',
    contrat: { startsOn: '2026-01-01', billingPeriod: 'monthly', amountCents: 90_000 },
    options: {
      prorataRule: 'calendar_days',
      versions: [
        { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-03-14', amountCents: 90_000, lines: [] },
        { amendmentId: 'avenant-1', amendmentNumber: 1, startsOn: '2026-03-15', endsOn: null, amountCents: 120_000, lines: [] },
      ],
    },
    jusquAu: '2026-03-31',
    // 900 € × 14/31 et 1 200 € × 17/31.
    attendu: { echeances: [90_000, 90_000, 40_645, 65_806], totalCents: 286_451 },
  },
]
