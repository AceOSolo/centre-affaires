import type { ProrataRule, RecurringBillingTiming } from '../../db/tenants.ts'
import { rateUnitLabels } from '../facturation/labels.ts'
import type { RateUnit } from '../facturation/schema.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { billingPeriodLabels, contractTypeLabels } from './labels.ts'
import { linesTotals, type LineDraft, type VatGroup } from './lignes.ts'
import type { BillingPeriod, ContractType } from './schema.ts'

/**
 * Instantané d'un document de contrat (R12, ADR 025) : ce qui a été remis au
 * client — le contrat à son activation, puis chaque avenant à sa signature —
 * figé en données structurées dans `contract_documents.snapshot`.
 *
 * Le document imprimable n'en est qu'une vue (`document-view.tsx`) : il se
 * rend depuis l'instantané seul, sans relire le contrat, le client ni le
 * centre. Tout ce qu'il affiche y est donc copié, libellés compris : renommer
 * un type de contrat ou une unité dans le code ne change pas un document
 * remis. La base en calcule l'empreinte SHA-256 (`snapshot::text`).
 *
 * Module pur : `buildContractSnapshot` assemble l'instantané depuis des
 * données déjà lues (`documents.ts` les lit dans la transaction qui
 * l'archive), et s'éprouve seul (`instantane.test.ts`).
 *
 * Forme versionnée par `schema` : une forme nouvelle prendra `contrat/2`, et
 * la vue saura encore rendre les documents `contrat/1` déjà archivés.
 */
export const CONTRACT_SNAPSHOT_SCHEMA = 'contrat/1'

/** Identité d'une partie, telle qu'elle figure au document. */
export type SnapshotParty = {
  name: string
  legalForm: string | null
  /** Capital social en centimes (vendeur seulement). */
  shareCapitalCents: number | null
  siren: string | null
  siret: string | null
  vatNumber: string | null
  /** « RCS Vienne » (vendeur seulement). */
  rcsCity: string | null
  /** Adresse, ligne par ligne, prête à imprimer. */
  address: string[]
  /** Ville seule, pour « Fait à … ». */
  city: string | null
  email: string | null
  phone: string | null
}

export type SnapshotLine = {
  description: string
  /** Ce que vise la ligne : « Bureau 1 (BUR-A1) », « Standard téléphonique ». */
  target: string | null
  quantity: number
  unit: RateUnit
  unitLabel: string
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  /** Montant net HT d'une période entière (ligne ponctuelle : une fois). */
  netAmountCents: number
  isRecurring: boolean
}

export type SnapshotSubscription = {
  serviceName: string
  /** Actes inclus par période de facture. */
  includedQuantity: number | null
  quantity: number
  unitLabel: string
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  startsOn: string
  endsOn: string | null
}

export type SnapshotResource = { code: string; name: string; typeLabel: string }

export type ContractSnapshot = {
  schema: typeof CONTRACT_SNAPSHOT_SCHEMA
  /** `contract` : le contrat initial ; `amendment` : un avenant. */
  kind: 'contract' | 'amendment'
  /** Jour du centre où le document a été établi. */
  issuedOn: string
  seller: SnapshotParty
  buyer: SnapshotParty
  contract: {
    reference: string
    contractType: ContractType
    contractTypeLabel: string
    startsOn: string
    endsOn: string | null
    billingPeriod: BillingPeriod
    billingPeriodLabel: string
    currency: string
    noticeDays: number
    commitmentMonths: number | null
    commitmentEndsOn: string | null
    tacitRenewal: boolean
    renewalMonths: number | null
    offerName: string | null
  }
  /** Ressource occupée par la version que le document constate ; nulle : aucune. */
  resource: SnapshotResource | null
  price: {
    /** Récurrent HT par période de la version. */
    amountCents: number
    lines: SnapshotLine[]
    totals: {
      recurringNetCents: number
      recurringVat: VatGroup[]
      recurringVatCents: number
      recurringGrossCents: number
      oneOffNetCents: number
      oneOffVat: VatGroup[]
      oneOffGrossCents: number
    }
  }
  /** Actes inclus et services souscrits avec le contrat. */
  subscriptions: SnapshotSubscription[]
  amendment: {
    number: number
    effectiveOn: string
    reason: string | null
    /** L'avenant change-t-il le prix (lignes ou montant) ? */
    priceChanged: boolean
    changesResource: boolean
    /** Ressource avant l'avenant, quand il la change. */
    previousResource: SnapshotResource | null
  } | null
  conditions: {
    billingTiming: RecurringBillingTiming
    billingTimingLabel: string
    prorataRule: ProrataRule
    prorataLabel: string
    paymentTermsDays: number
    latePaymentPenaltyText: string
    recoveryIndemnityCents: number
    earlyPaymentDiscountText: string
    vatOnDebits: boolean
  }
}

/** Ce qu'il faut du centre : identité, règles de facturation. */
export type SnapshotTenant = {
  name: string
  legalName: string | null
  legalForm: string | null
  shareCapitalCents: number | null
  siren: string | null
  siret: string | null
  vatNumber: string | null
  rcsCity: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
  email: string | null
  phone: string | null
  prorataRule: ProrataRule
  recurringBillingTiming: RecurringBillingTiming
  invoicePaymentTermsDays: number
  latePaymentPenaltyText: string
  recoveryIndemnityCents: number
  earlyPaymentDiscountText: string
  vatOnDebits: boolean
}

export type SnapshotClient = {
  name: string
  legalForm: string | null
  siret: string | null
  vatNumber: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
  email: string | null
  phone: string | null
}

export type SnapshotContract = {
  reference: string
  contractType: ContractType
  startsOn: string
  endsOn: string | null
  billingPeriod: BillingPeriod
  currency: string
  noticeDays: number
  commitmentMonths: number | null
  commitmentEndsOn: string | null
  tacitRenewal: boolean
  renewalMonths: number | null
  amountCents: number
  vatRateBp: number
}

export type SnapshotResourceInput = { code: string; name: string; resourceType: ResourceType }

/** Une ligne lue en base, avec le libellé de sa cible. */
export type SnapshotLineInput = Omit<LineDraft, 'id' | 'offerItemId' | 'target'> & {
  targetLabel: string | null
  netAmountCents: number
}

export type SnapshotInput = {
  issuedOn: string
  tenant: SnapshotTenant
  client: SnapshotClient
  contract: SnapshotContract
  offerName: string | null
  resource: SnapshotResourceInput | null
  /** Lignes de la version constatée ; vide : la version se facture de `versionAmountCents`. */
  lines: readonly SnapshotLineInput[]
  versionAmountCents: number
  subscriptions: readonly (Omit<SnapshotSubscription, 'unitLabel'> & { unit: RateUnit })[]
  amendment: {
    number: number
    effectiveOn: string
    reason: string | null
    priceChanged: boolean
    changesResource: boolean
    previousResource: SnapshotResourceInput | null
  } | null
}

export const prorataRuleLabels: Record<ProrataRule, string> = {
  calendar_days:
    'Une période partielle est due au prorata des jours couverts, sur le nombre réel de jours de la période.',
  thirty_day_month:
    'Une période partielle est due au prorata des jours couverts, chaque mois comptant pour trente jours.',
  none: 'Une période commencée est due en entier, sans prorata.',
}

export const billingTimingLabels: Record<RecurringBillingTiming, string> = {
  in_advance: 'à terme à échoir, en début de période',
  in_arrears: 'à terme échu, en fin de période',
}

function addressLines(party: {
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
}): string[] {
  const cityLine = [party.postalCode, party.city].filter(Boolean).join(' ')
  return [
    party.addressLine1,
    party.addressLine2,
    cityLine || null,
    party.country !== 'FR' ? party.country : null,
  ].filter((line): line is string => Boolean(line && line.trim()))
}

function snapshotResource(resource: SnapshotResourceInput | null): SnapshotResource | null {
  return resource
    ? { code: resource.code, name: resource.name, typeLabel: resourceTypeLabels[resource.resourceType] }
    : null
}

/**
 * Assemble l'instantané d'un document de contrat ou d'avenant. Une version
 * sans ligne se présente en une ligne « Redevance », à la TVA du contrat :
 * c'est ainsi qu'elle est facturée (ADR 025).
 */
export function buildContractSnapshot(input: SnapshotInput): ContractSnapshot {
  const { tenant, client, contract } = input
  const contractTypeLabel = contractTypeLabels[contract.contractType]

  const lines: SnapshotLine[] =
    input.lines.length > 0
      ? input.lines.map((line) => ({
          description: line.description,
          target: line.targetLabel,
          quantity: line.quantity,
          unit: line.unit,
          unitLabel: rateUnitLabels[line.unit],
          unitPriceCents: line.unitPriceCents,
          discountBp: line.discountBp,
          discountAmountCents: line.discountAmountCents,
          vatRateBp: line.vatRateBp,
          netAmountCents: line.netAmountCents,
          isRecurring: line.isRecurring,
        }))
      : [
          {
            description: `Redevance — ${contractTypeLabel.toLowerCase()}`,
            target: input.resource ? `${input.resource.name} (${input.resource.code})` : null,
            quantity: 1,
            unit: 'unit',
            unitLabel: billingPeriodLabels[contract.billingPeriod],
            unitPriceCents: input.versionAmountCents,
            discountBp: null,
            discountAmountCents: null,
            vatRateBp: contract.vatRateBp,
            netAmountCents: input.versionAmountCents,
            isRecurring: true,
          },
        ]

  const totals = linesTotals(
    lines.map((line) => ({
      offerItemId: null,
      target: { kind: 'none' },
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      discountAmountCents: line.discountAmountCents,
      vatRateBp: line.vatRateBp,
      isRecurring: line.isRecurring,
    })),
  )

  return {
    schema: CONTRACT_SNAPSHOT_SCHEMA,
    kind: input.amendment ? 'amendment' : 'contract',
    issuedOn: input.issuedOn,
    seller: {
      name: tenant.legalName || tenant.name,
      legalForm: tenant.legalForm,
      shareCapitalCents: tenant.shareCapitalCents,
      siren: tenant.siren,
      siret: tenant.siret,
      vatNumber: tenant.vatNumber,
      rcsCity: tenant.rcsCity,
      address: addressLines(tenant),
      city: tenant.city,
      email: tenant.email,
      phone: tenant.phone,
    },
    buyer: {
      name: client.name,
      legalForm: client.legalForm,
      shareCapitalCents: null,
      siren: client.siret ? client.siret.slice(0, 9) : null,
      siret: client.siret,
      vatNumber: client.vatNumber,
      rcsCity: null,
      address: addressLines(client),
      city: client.city,
      email: client.email,
      phone: client.phone,
    },
    contract: {
      reference: contract.reference,
      contractType: contract.contractType,
      contractTypeLabel,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
      billingPeriod: contract.billingPeriod,
      billingPeriodLabel: billingPeriodLabels[contract.billingPeriod],
      currency: contract.currency,
      noticeDays: contract.noticeDays,
      commitmentMonths: contract.commitmentMonths,
      commitmentEndsOn: contract.commitmentEndsOn,
      tacitRenewal: contract.tacitRenewal,
      renewalMonths: contract.renewalMonths,
      offerName: input.offerName,
    },
    resource: snapshotResource(input.resource),
    price: {
      amountCents: totals.recurringNetCents,
      lines,
      totals,
    },
    subscriptions: input.subscriptions.map((subscription) => ({
      serviceName: subscription.serviceName,
      includedQuantity: subscription.includedQuantity,
      quantity: subscription.quantity,
      unitLabel: rateUnitLabels[subscription.unit],
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
      discountAmountCents: subscription.discountAmountCents,
      vatRateBp: subscription.vatRateBp,
      startsOn: subscription.startsOn,
      endsOn: subscription.endsOn,
    })),
    amendment: input.amendment
      ? {
          number: input.amendment.number,
          effectiveOn: input.amendment.effectiveOn,
          reason: input.amendment.reason,
          priceChanged: input.amendment.priceChanged,
          changesResource: input.amendment.changesResource,
          previousResource: snapshotResource(input.amendment.previousResource),
        }
      : null,
    conditions: {
      billingTiming: tenant.recurringBillingTiming,
      billingTimingLabel: billingTimingLabels[tenant.recurringBillingTiming],
      prorataRule: tenant.prorataRule,
      prorataLabel: prorataRuleLabels[tenant.prorataRule],
      paymentTermsDays: tenant.invoicePaymentTermsDays,
      latePaymentPenaltyText: tenant.latePaymentPenaltyText,
      recoveryIndemnityCents: tenant.recoveryIndemnityCents,
      earlyPaymentDiscountText: tenant.earlyPaymentDiscountText,
      vatOnDebits: tenant.vatOnDebits,
    },
  }
}

/**
 * Lecture prudente d'un instantané archivé : sa forme est vérifiée avant le
 * rendu. `undefined` pour une forme inconnue — un document d'une version
 * future du code, ou écrit à la main — que la vue signale au lieu de planter.
 */
export function readContractSnapshot(value: unknown): ContractSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as Partial<ContractSnapshot>
  if (snapshot.schema !== CONTRACT_SNAPSHOT_SCHEMA) return undefined
  if (!snapshot.contract || !snapshot.seller || !snapshot.buyer || !snapshot.price) return undefined
  if (!Array.isArray(snapshot.price.lines) || !Array.isArray(snapshot.subscriptions)) return undefined
  return snapshot as ContractSnapshot
}
