import { addDays, addMonths, earliestEndOn } from './echeancier.ts'

/**
 * Reconduction tacite (R10, ADR 023, ADR 033), sans base : éprouvée seule
 * (`reconduction.test.ts`).
 *
 * Un contrat à reconduction tacite se prolonge de `renewal_months` à son
 * terme, faute de préavis. La reconduction est **acquise** dès qu'un préavis
 * donné ce jour-là ne pourrait plus mettre fin au contrat à son terme — le
 * jour de la demande compris, et pas avant la fin de l'engagement
 * (`earliestEndOn`, jumelle de `contract_earliest_end_on`). La tâche nocturne
 * l'inscrit alors : le nouveau terme est connu d'avance, l'occupation et la
 * facturation suivent sans trou au passage du terme.
 *
 * Un contrat résilié (`terminated_on`) ne se reconduit pas : le préavis a été
 * donné. Une résiliation enregistrée après la reconduction reste possible
 * (accord, préavis reçu à temps mais saisi en retard) : elle raccourcit le
 * contrat comme toute résiliation.
 */

/** Ce qu'il faut d'un contrat pour décider de sa reconduction. */
export type TacitRenewalTerms = {
  /** Terme en cours, compris. */
  endsOn: string
  /** Durée de chaque reconduction, en mois. */
  renewalMonths: number
  /** Préavis, en jours, jour de la demande compris. */
  noticeDays: number
  /** Dernier jour d'engagement ; nul sans engagement. */
  commitmentEndsOn: string | null
}

/**
 * Terme suivant : du lendemain du terme, `months` mois, jusqu'à la veille.
 * Du 31 décembre, douze mois : le 31 décembre suivant ; du 28 février 2027,
 * douze mois : le 29 février 2028.
 */
export function nextTerm(endsOn: string, months: number): string {
  return addDays(addMonths(addDays(endsOn, 1), months), -1)
}

/** Un préavis donné `today` mettrait-il encore fin au contrat à ce terme ? */
export function noticeStillPossible(terms: Omit<TacitRenewalTerms, 'renewalMonths'>, today: string): boolean {
  return earliestEndOn(today, terms.noticeDays, terms.commitmentEndsOn) <= terms.endsOn
}

/**
 * Nouveau terme d'un contrat reconduit tacitement au jour `today`, ou nul
 * s'il n'est pas encore reconduit. Rattrape plusieurs périodes d'un coup —
 * un contrat repris de l'existant, ou une tâche restée arrêtée — jusqu'au
 * premier terme qu'un préavis donné ce jour-là peut encore atteindre.
 */
export function tacitRenewalTerm(terms: TacitRenewalTerms, today: string): string | null {
  if (terms.renewalMonths < 1) return null
  let term = terms.endsOn
  // La borne ne sert qu'à couper une boucle sur une saisie aberrante.
  for (let guard = 0; guard < 1200 && !noticeStillPossible({ ...terms, endsOn: term }, today); guard += 1) {
    term = nextTerm(term, terms.renewalMonths)
  }
  return term === terms.endsOn ? null : term
}
