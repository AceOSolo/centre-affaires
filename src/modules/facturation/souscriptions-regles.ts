import { lineNetAmountCents } from './montants.ts'
import {
  field,
  formatCalendarDay,
  isIsoDate,
  parseInteger,
  parsePercentToBp,
  shiftIsoDate,
  type FormLike,
} from './saisie.ts'
import type { ServiceNature } from './schema.ts'
import { parseAmountToCents } from './tarifs.ts'

/**
 * Règles des services souscrits (R18, R07, ADR 024).
 *
 * Ce qui a été convenu ne se réécrit pas : la base refuse toute modification
 * d'une souscription hors de sa fin, de ses notes et de son archivage
 * (`subscribed_services_guard`, CA004). Changer la quantité ou le prix, c'est
 * donc mettre fin à la souscription la veille de la date d'effet et souscrire
 * aux nouvelles conditions à cette date — l'historique des prix se lit en
 * lignes.
 *
 * Module pur : l'écran, les actions serveur et les tests passent par les
 * mêmes fonctions. Les dates sont des jours civils du centre, « AAAA-MM-JJ ».
 */

/* ------------------------------------------------------------------------ */
/* État d'une souscription                                                  */
/* ------------------------------------------------------------------------ */

export type SubscriptionState = 'upcoming' | 'active' | 'ended' | 'cancelled'

export const subscriptionStateLabels: Record<SubscriptionState, string> = {
  upcoming: 'À venir',
  active: 'En cours',
  ended: 'Terminée',
  cancelled: 'Annulée',
}

/** Le libellé porte l'état ; la teinte l'accompagne (ADR 004). */
export const subscriptionStateStyles: Record<SubscriptionState, string> = {
  upcoming: 'bg-accent/15 text-primary',
  active: 'bg-primary text-primary-foreground',
  ended: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

export function subscriptionState(
  subscription: { startsOn: string; endsOn: string | null; deletedAt: Date | null },
  today: string,
): SubscriptionState {
  if (subscription.deletedAt) return 'cancelled'
  if (subscription.startsOn > today) return 'upcoming'
  if (subscription.endsOn !== null && subscription.endsOn < today) return 'ended'
  return 'active'
}

/** En cours ou à venir : ce qui sera encore facturé. */
export function isCurrent(state: SubscriptionState): boolean {
  return state === 'active' || state === 'upcoming'
}

/* ------------------------------------------------------------------------ */
/* Conditions : quantité, prix, remise, TVA, inclus                         */
/* ------------------------------------------------------------------------ */

export type SubscriptionTerms = {
  quantity: number
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  /** Actes inclus par période ; nul pour un forfait. */
  includedQuantity: number | null
}

export type DiscountKind = 'none' | 'percent' | 'amount'

/** Champs du formulaire de souscription, tels que saisis : réaffichés après un refus. */
export type SubscriptionValues = {
  serviceId: string
  contractId: string
  quantity: string
  unitPrice: string
  discountKind: DiscountKind
  discountPercent: string
  discountAmount: string
  vatRate: string
  includedQuantity: string
  startsOn: string
  endsOn: string
  effectiveOn: string
  notes: string
}

export type SubscriptionField = keyof SubscriptionValues
export type SubscriptionFieldErrors = Partial<Record<SubscriptionField, string>>

/** Libellés du résumé d'erreurs, ceux des champs. */
export const subscriptionFieldLabels: Record<SubscriptionField, string> = {
  serviceId: 'Service',
  contractId: 'Contrat',
  quantity: 'Quantité',
  unitPrice: 'Prix unitaire HT',
  discountKind: 'Remise',
  discountPercent: 'Remise en pourcentage',
  discountAmount: 'Remise en montant',
  vatRate: 'TVA',
  includedQuantity: 'Actes inclus par période',
  startsOn: 'Début',
  endsOn: 'Fin',
  effectiveOn: 'À compter du',
  notes: 'Notes',
}

const discountKinds: readonly DiscountKind[] = ['none', 'percent', 'amount']

/** Ce que le formulaire a reçu, tel quel. */
export function subscriptionValues(form: FormLike): SubscriptionValues {
  const kind = field(form, 'discountKind')
  return {
    serviceId: field(form, 'serviceId'),
    contractId: field(form, 'contractId'),
    quantity: field(form, 'quantity'),
    unitPrice: field(form, 'unitPrice'),
    discountKind: discountKinds.includes(kind as DiscountKind) ? (kind as DiscountKind) : 'none',
    discountPercent: field(form, 'discountPercent'),
    discountAmount: field(form, 'discountAmount'),
    vatRate: field(form, 'vatRate'),
    includedQuantity: field(form, 'includedQuantity'),
    startsOn: field(form, 'startsOn'),
    endsOn: field(form, 'endsOn'),
    effectiveOn: field(form, 'effectiveOn'),
    notes: field(form, 'notes'),
  }
}

/**
 * Lit les conditions d'une souscription, selon la nature du service :
 *
 * - un forfait a une quantité, un prix par période, une remise en pourcentage
 *   ou en montant par période, et pas d'inclus ;
 * - un acte se souscrit en quantité 1 : son prix est celui d'un acte au-delà
 *   des inclus, sa remise un pourcentage (une remise « par période » ne
 *   s'applique pas à un acte), ses inclus un nombre d'actes par période.
 */
export function readTerms(
  values: SubscriptionValues,
  nature: ServiceNature,
): { terms?: SubscriptionTerms; errors: SubscriptionFieldErrors } {
  const errors: SubscriptionFieldErrors = {}

  const quantity = nature === 'act' ? 1 : parseInteger(values.quantity, 1)
  if (quantity === undefined) errors.quantity = 'Saisissez un nombre entier, 1 ou plus.'

  const unitPriceCents = parseAmountToCents(values.unitPrice)
  if (unitPriceCents === undefined) {
    errors.unitPrice = 'Saisissez un montant en euros, comme 50,00.'
  }

  let discountBp: number | null = null
  let discountAmountCents: number | null = null
  if (values.discountKind === 'percent') {
    const bp = parsePercentToBp(values.discountPercent)
    if (bp === undefined || bp === 0) {
      errors.discountPercent = 'Saisissez un pourcentage entre 0,01 et 100, comme 10 ou 12,5.'
    } else discountBp = bp
  } else if (values.discountKind === 'amount') {
    if (nature === 'act') {
      errors.discountAmount =
        'Une remise en montant vaut par période : pour un acte, saisissez un pourcentage.'
    } else {
      const cents = parseAmountToCents(values.discountAmount)
      if (cents === undefined || cents === 0) {
        errors.discountAmount = 'Saisissez un montant en euros, comme 10,00.'
      } else discountAmountCents = cents
    }
  }

  const vatRateBp = parsePercentToBp(values.vatRate)
  if (vatRateBp === undefined) errors.vatRate = 'Saisissez un taux entre 0 et 100, comme 20 ou 5,5.'

  let includedQuantity: number | null = null
  if (nature === 'act') {
    const included = values.includedQuantity === '' ? 0 : parseInteger(values.includedQuantity, 0)
    if (included === undefined) {
      errors.includedQuantity = 'Saisissez un nombre entier d’actes, 0 ou plus.'
    } else includedQuantity = included
  }

  if (
    quantity !== undefined &&
    unitPriceCents !== undefined &&
    discountAmountCents !== null &&
    lineNetAmountCents({ quantity, unitPriceCents, discountAmountCents }) < 0
  ) {
    errors.discountAmount = 'La remise dépasse le montant de la période.'
  }

  if (Object.keys(errors).length > 0) return { errors }
  return {
    errors,
    terms: {
      quantity: quantity as number,
      unitPriceCents: unitPriceCents as number,
      discountBp,
      discountAmountCents,
      vatRateBp: vatRateBp as number,
      includedQuantity,
    },
  }
}

/** Mêmes conditions : souscrire à nouveau n'aurait rien changé. */
export function sameTerms(a: SubscriptionTerms, b: SubscriptionTerms): boolean {
  return (
    a.quantity === b.quantity &&
    a.unitPriceCents === b.unitPriceCents &&
    a.discountBp === b.discountBp &&
    a.discountAmountCents === b.discountAmountCents &&
    a.vatRateBp === b.vatRateBp &&
    a.includedQuantity === b.includedQuantity
  )
}

/* ------------------------------------------------------------------------ */
/* Souscrire                                                                */
/* ------------------------------------------------------------------------ */

/** Ce que le formulaire doit savoir du service choisi. */
export type SubscribableService = {
  id: string
  nature: ServiceNature
  isActive: boolean
  archived: boolean
}

export type SubscriptionInput = SubscriptionTerms & {
  serviceId: string
  contractId: string | null
  startsOn: string
  endsOn: string | null
  notes: string | null
}

/**
 * Lecture du formulaire « Souscrire un service ». Rend les erreurs de tous
 * les champs d'un coup, pour le résumé d'erreurs.
 */
export function readSubscriptionForm(
  form: FormLike,
  context: {
    services: readonly SubscribableService[]
    /** Contrats du client auxquels rattacher la souscription. */
    contractIds: readonly string[]
  },
):
  | { values: SubscriptionValues; input: SubscriptionInput; fieldErrors?: undefined }
  | { values: SubscriptionValues; fieldErrors: SubscriptionFieldErrors } {
  const values = subscriptionValues(form)
  const fieldErrors: SubscriptionFieldErrors = {}

  const service = context.services.find((candidate) => candidate.id === values.serviceId)
  if (!service) fieldErrors.serviceId = 'Choisissez un service du catalogue.'
  else if (service.archived || !service.isActive) {
    fieldErrors.serviceId = 'Ce service n’est plus proposé à la souscription.'
  }

  if (values.contractId && !context.contractIds.includes(values.contractId)) {
    fieldErrors.contractId = 'Choisissez un contrat de ce client, ou aucun.'
  }

  const { terms, errors } = readTerms(values, service?.nature ?? 'package')
  Object.assign(fieldErrors, errors)

  if (!isIsoDate(values.startsOn)) fieldErrors.startsOn = 'Saisissez la date du premier jour.'
  if (values.endsOn) {
    if (!isIsoDate(values.endsOn)) fieldErrors.endsOn = 'Date illisible.'
    else if (isIsoDate(values.startsOn) && values.endsOn < values.startsOn) {
      fieldErrors.endsOn = 'Le dernier jour ne peut pas précéder le premier.'
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !terms || !service) return { values, fieldErrors }
  return {
    values,
    input: {
      ...terms,
      serviceId: service.id,
      contractId: values.contractId || null,
      startsOn: values.startsOn,
      endsOn: values.endsOn || null,
      notes: values.notes || null,
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Changer les conditions, mettre fin, annuler                              */
/* ------------------------------------------------------------------------ */

/** Ce qu'il faut d'une souscription pour décider d'un changement. */
export type SubscriptionPeriod = {
  startsOn: string
  endsOn: string | null
}

/**
 * Plan d'un changement de conditions à une date d'effet :
 *
 * - `split` : la souscription prend fin la veille, une nouvelle commence ce
 *   jour-là et garde la fin prévue ;
 * - `replace` : la date d'effet est le premier jour — rien n'a été facturé —,
 *   la souscription est annulée et remplacée à la même date.
 *
 * Refusé si la date tombe hors de la souscription, ou sur un jour déjà
 * facturé aux anciennes conditions (`billedThrough`, dernier jour facturé) :
 * les mêmes jours seraient facturés deux fois.
 */
export type ConditionChangePlan =
  | { ok: true; mode: 'split'; previousEndsOn: string; nextStartsOn: string; nextEndsOn: string | null }
  | { ok: true; mode: 'replace'; nextStartsOn: string; nextEndsOn: string | null }
  | { ok: false; error: string }

export function planConditionChange(
  current: SubscriptionPeriod,
  effectiveOn: string,
  billedThrough: string | null,
): ConditionChangePlan {
  if (!isIsoDate(effectiveOn)) return { ok: false, error: 'Saisissez la date d’effet.' }
  if (effectiveOn < current.startsOn) {
    return {
      ok: false,
      error: `La souscription commence le ${formatCalendarDay(current.startsOn)} : la date d’effet ne peut pas la précéder.`,
    }
  }
  if (current.endsOn !== null && effectiveOn > current.endsOn) {
    return {
      ok: false,
      error: `La souscription prend fin le ${formatCalendarDay(current.endsOn)} : souscrivez à nouveau après cette date.`,
    }
  }
  if (billedThrough !== null && effectiveOn <= billedThrough) {
    return {
      ok: false,
      error: `Déjà facturée jusqu’au ${formatCalendarDay(billedThrough)} : les nouvelles conditions s’appliquent au plus tôt le ${formatCalendarDay(shiftIsoDate(billedThrough, 1))}.`,
    }
  }
  if (effectiveOn === current.startsOn) {
    return { ok: true, mode: 'replace', nextStartsOn: effectiveOn, nextEndsOn: current.endsOn }
  }
  return {
    ok: true,
    mode: 'split',
    previousEndsOn: shiftIsoDate(effectiveOn, -1),
    nextStartsOn: effectiveOn,
    nextEndsOn: current.endsOn,
  }
}

/**
 * Contrôle d'une date de fin (dernier jour compris ; nulle : sans fin).
 * Une souscription ne finit ni avant son premier jour — elle s'annule —, ni
 * avant le dernier jour déjà facturé — un avoir d'abord.
 */
export function checkSubscriptionEnd(
  current: SubscriptionPeriod,
  endsOn: string | null,
  billedThrough: string | null,
): string | null {
  if (endsOn === null) return null
  if (!isIsoDate(endsOn)) return 'Saisissez une date de fin lisible.'
  if (endsOn < current.startsOn) {
    return `La souscription commence le ${formatCalendarDay(current.startsOn)} : pour la retirer avant son début, annulez-la.`
  }
  if (billedThrough !== null && endsOn < billedThrough) {
    return `Déjà facturée jusqu’au ${formatCalendarDay(billedThrough)} : la fin ne peut pas précéder ce jour. Établissez d’abord un avoir.`
  }
  return null
}

/**
 * Annuler une souscription (archivage, `deleted_at`) n'est permis que si rien
 * n'a été facturé à son titre : sinon on y met fin, la facture garde sa
 * source.
 */
export function cancellationRefusal(billedLineCount: number): string | null {
  return billedLineCount > 0
    ? 'Cette souscription a déjà été facturée : mettez-y fin plutôt que de l’annuler.'
    : null
}

/* ------------------------------------------------------------------------ */
/* Valorisation des actes : quantités incluses                              */
/* ------------------------------------------------------------------------ */

/** Un acte exécuté dans la période de facturation : un pli ouvert, par exemple. */
export type ActOccurrence = {
  id: string
  /** Jour du centre où l'acte a eu lieu (`opened_at` dans le fuseau du centre). */
  day: string
  /** Instant de l'acte, pour l'ordre : les premiers actes de la période sont les inclus. */
  at: Date
}

/** Une souscription vivante au service de l'acte. */
export type ActSubscription = {
  id: string
  startsOn: string
  endsOn: string | null
  unitPriceCents: number
  discountBp: number | null
  vatRateBp: number
  currency: string
  includedQuantity: number | null
}

/** Le service du catalogue, quand il existe. */
export type ActCatalogueService = {
  id: string
  unitPriceCents: number
  vatRateBp: number
  currency: string
}

export type PricedAct = {
  actId: string
  /**
   * `included` : compté dans les inclus de la souscription, à 0 € ;
   * `subscription` : au-delà des inclus, au prix figé de la souscription ;
   * `catalogue` : sans souscription en vigueur, au prix du catalogue ;
   * `unpriced` : ni souscription ni service au catalogue — à signaler, pas à
   * facturer zéro.
   */
  source: 'included' | 'subscription' | 'catalogue' | 'unpriced'
  subscriptionId: string | null
  unitPriceCents: number | null
  discountBp: number | null
  /** Net HT de l'acte, remise comprise. Nul : non valorisé. */
  netAmountCents: number | null
  vatRateBp: number | null
  currency: string | null
}

function inEffect(subscription: ActSubscription, day: string): boolean {
  return subscription.startsOn <= day && (subscription.endsOn === null || day <= subscription.endsOn)
}

/**
 * Valorise les actes d'une période de facturation (ADR 024, « Ce qu'un acte
 * coûte ») :
 *
 * 1. la souscription vivante en vigueur le jour de l'acte : ses
 *    `included_quantity` premiers actes de la période, par ordre
 *    chronologique, sont inclus à 0 € ; les suivants sont dus à son prix
 *    figé, remise en pourcentage comprise ;
 * 2. sans souscription, le prix du catalogue ;
 * 3. sans service au catalogue, l'acte n'est pas valorisé.
 *
 * Si deux souscriptions sont en vigueur le même jour (rattachées à deux
 * contrats différents), la plus avantageuse pour le client l'emporte : celle
 * qui a encore des inclus, puis le prix net le plus bas, puis la plus
 * ancienne. Choix par défaut, à valider par le centre.
 *
 * `acts` ne contient que les actes de la période ; `subscriptions` que les
 * souscriptions vivantes (non archivées) du client à ce service.
 */
export function priceActs(
  acts: readonly ActOccurrence[],
  subscriptions: readonly ActSubscription[],
  catalogue: ActCatalogueService | null,
): PricedAct[] {
  const used = new Map<string, number>()
  const ordered = [...acts].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const netOf = (subscription: ActSubscription) =>
    lineNetAmountCents({
      quantity: 1,
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
    })
  const remaining = (subscription: ActSubscription) =>
    (subscription.includedQuantity ?? 0) - (used.get(subscription.id) ?? 0)

  return ordered.map((act): PricedAct => {
    const candidates = subscriptions
      .filter((subscription) => inEffect(subscription, act.day))
      .sort(
        (a, b) =>
          Number(remaining(b) > 0) - Number(remaining(a) > 0) ||
          netOf(a) - netOf(b) ||
          (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    const subscription = candidates[0]

    if (subscription) {
      const base = {
        actId: act.id,
        subscriptionId: subscription.id,
        unitPriceCents: subscription.unitPriceCents,
        discountBp: subscription.discountBp,
        vatRateBp: subscription.vatRateBp,
        currency: subscription.currency,
      }
      if (remaining(subscription) > 0) {
        used.set(subscription.id, (used.get(subscription.id) ?? 0) + 1)
        return { ...base, source: 'included', netAmountCents: 0 }
      }
      return { ...base, source: 'subscription', netAmountCents: netOf(subscription) }
    }

    if (catalogue) {
      return {
        actId: act.id,
        source: 'catalogue',
        subscriptionId: null,
        unitPriceCents: catalogue.unitPriceCents,
        discountBp: null,
        netAmountCents: catalogue.unitPriceCents,
        vatRateBp: catalogue.vatRateBp,
        currency: catalogue.currency,
      }
    }

    return {
      actId: act.id,
      source: 'unpriced',
      subscriptionId: null,
      unitPriceCents: null,
      discountBp: null,
      netAmountCents: null,
      vatRateBp: null,
      currency: null,
    }
  })
}
