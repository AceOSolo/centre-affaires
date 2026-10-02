import { formatCents } from '../facturation/tarifs.ts'
import { contractTypeLabels, billingPeriodSuffixes } from './labels.ts'
import { lineToFormValues, targetOf, type LineFormValues } from './lignes.ts'
import type { Contract } from './schema.ts'
import { segmentOn, type ContractSegment, type PriceVersion } from './versions.ts'

/**
 * Ce que l'écran d'un avenant montre de la version qu'il remplacerait :
 * ses lignes, recopiées pour être ajustées, son prix et sa ressource à la
 * date d'effet. Sans base : les versions et segments sont déjà lus.
 */

/**
 * Lignes de la version en vigueur à la date d'effet, au format de saisie et
 * sans identifiant : ce sont des copies, qui deviendront les lignes de
 * l'avenant. Une version sans ligne est proposée en une ligne « Redevance ».
 */
export function versionLinesForForm(
  version: PriceVersion | undefined,
  contract: Pick<Contract, 'contractType' | 'amountCents' | 'vatRateBp' | 'resourceId'>,
): LineFormValues[] {
  if (version && version.lines.length > 0) {
    return version.lines.map((line, index) =>
      lineToFormValues(String(index), { ...line, id: undefined, target: targetOf(line) }),
    )
  }
  return [
    lineToFormValues('0', {
      offerItemId: null,
      target: contract.resourceId ? { kind: 'resource', resourceId: contract.resourceId } : { kind: 'none' },
      description: `Redevance — ${contractTypeLabels[contract.contractType].toLowerCase()}`,
      quantity: 1,
      unit: 'unit',
      unitPriceCents: version?.amountCents ?? contract.amountCents,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: contract.vatRateBp,
      isRecurring: true,
    }),
  ]
}

/** « 900,00 € par mois » : le prix de la version en vigueur à cette date. */
export function versionAmountLabel(
  versions: readonly PriceVersion[],
  day: string,
  contract: Pick<Contract, 'amountCents' | 'currency' | 'billingPeriod'>,
): string {
  const version = segmentOn(versions, day)
  return `${formatCents(version?.amountCents ?? contract.amountCents, contract.currency)} ${billingPeriodSuffixes[contract.billingPeriod]}`
}

/** « Bureau 1 (BUR-A1) » ou « aucune » : la ressource du segment en vigueur à cette date. */
export function segmentResourceLabel(segments: readonly ContractSegment[], day: string): string {
  const resource = segmentOn(segments, day)?.resource
  return resource ? `${resource.name} (${resource.code})` : 'aucune'
}
