import type postgres from 'postgres'

import { serviceCodes, type RateUnit, type ServiceNature } from './schema.ts'

/**
 * Services que le code retrouve par leur code stable (ADR 024) : ils doivent
 * exister au catalogue de chaque centre pour que la facturation valorise ce
 * qu'ils désignent. L'ouverture d'un pli (R14), et depuis la vague 3 la
 * numérisation seule et la réexpédition demandées sur un pli (R21, ADR 037).
 *
 * La désignation, la nature, l'unité et la TVA sont données ici. **Le prix ne
 * l'est pas** : aucun prix n'est inventé (ADR 009). Le centre le fixe, à
 * l'écran Services ou dans `infra/configurer-centre.mjs`. Tant qu'il manque,
 * le service n'est pas créé : un pli ouvert n'est pas valorisé et le lot de
 * facturation le signale, plutôt que de facturer zéro.
 *
 * Importé par `infra/configurer-centre.mjs` : ce module ne dépend que du
 * schéma, et s'exécute tel quel sous Node 24.
 */
export type ExpectedService = {
  code: string
  name: string
  description: string
  nature: ServiceNature
  unit: RateUnit
  /** Taux de TVA proposé, en points de base. À valider par l'expert-comptable. */
  vatRateBp: number
  /** Ce que l'application en fait, pour l'écran qui signale son absence. */
  purpose: string
}

export const expectedServices: readonly ExpectedService[] = [
  {
    code: serviceCodes.mailOpening,
    name: 'Ouverture et numérisation d’un pli',
    description:
      'Ouverture d’un pli reçu pour le client et numérisation de son contenu, déposée dans son espace.',
    nature: 'act',
    unit: 'unit',
    vatRateBp: 2_000,
    purpose: 'Chaque pli ouvert et numérisé est porté sur la facture du client à ce prix (R14).',
  },
  // Demandes sur un pli (R21, ADR 037) : chacune se facture par sa demande faite.
  {
    code: serviceCodes.mailScan,
    name: 'Numérisation d’un pli déjà ouvert',
    description:
      'Numérisation, à la demande du client, d’un pli déjà ouvert : pages supplémentaires, numérisation effacée au terme de sa conservation.',
    nature: 'act',
    unit: 'unit',
    vatRateBp: 2_000,
    purpose: 'Chaque numérisation demandée et faite est portée sur la facture du client à ce prix (R21).',
  },
  {
    code: serviceCodes.mailForwarding,
    name: 'Réexpédition d’un pli',
    description:
      'Réexpédition d’un pli à l’adresse indiquée par le client. Les frais d’affranchissement réels s’y ajoutent, au centime relevé.',
    nature: 'act',
    unit: 'unit',
    vatRateBp: 2_000,
    purpose:
      'Chaque réexpédition faite est portée sur la facture du client à ce prix, avec ses frais d’affranchissement relevés (R21).',
  },
]

/** Services attendus qui n'ont pas de service vivant de même code. */
export function missingExpectedServices(
  livingCodes: readonly (string | null)[],
): ExpectedService[] {
  const present = new Set(livingCodes)
  return expectedServices.filter((service) => !present.has(service.code))
}

export type SeedReport = {
  /** Codes créés par cet appel. */
  created: string[]
  /** Codes qui avaient déjà un service vivant : laissés tels quels. */
  existing: string[]
  /** Codes sans prix fixé : non créés. */
  withoutPrice: string[]
}

/**
 * Crée les services attendus qui manquent, au prix fixé par le centre
 * (`prices`, en centimes, par code). Idempotent : un service vivant de même
 * code est laissé tel quel — son prix se gère à l'écran, rejouer le script ne
 * l'écrase pas.
 *
 * À appeler dans une transaction où `app.tenant_id` est posé, sous le rôle
 * applicatif : les politiques d'isolation par centre s'appliquent.
 */
export async function seedExpectedServices<Types extends Record<string, unknown>>(
  tx: postgres.TransactionSql<Types>,
  prices: Readonly<Record<string, number | null | undefined>>,
): Promise<SeedReport> {
  const report: SeedReport = { created: [], existing: [], withoutPrice: [] }
  for (const service of expectedServices) {
    const [living] = await tx`
      select id from services where code = ${service.code} and deleted_at is null`
    if (living) {
      report.existing.push(service.code)
      continue
    }
    const price = prices[service.code]
    if (price === null || price === undefined) {
      report.withoutPrice.push(service.code)
      continue
    }
    if (!Number.isSafeInteger(price) || price < 0) {
      throw new RangeError(`Prix de ${service.code} invalide : un entier de centimes, 0 ou plus.`)
    }
    const inserted = await tx`
      insert into services (code, name, description, nature, unit, unit_price_cents, vat_rate_bp)
      values (${service.code}, ${service.name}, ${service.description}, ${service.nature},
              ${service.unit}, ${price}, ${service.vatRateBp})
      on conflict (tenant_id, code) where code is not null and deleted_at is null do nothing
      returning id`
    if (inserted.length > 0) report.created.push(service.code)
    else report.existing.push(service.code)
  }
  return report
}
