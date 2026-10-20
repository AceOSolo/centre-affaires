import { and, eq, isNull, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { resources } from '../ressources/schema.ts'
import type { ServiceFromDolibarr, TariffFromDolibarr } from './produits-dolibarr.ts'
import { defaultRatePlanOn } from './queries.ts'
import { ratePlanItems, ratePlans, services } from './schema.ts'

/**
 * Écriture des produits reçus de Dolibarr (ADR 049) : un service du catalogue
 * ou un prix de la grille par défaut, selon `readDolibarrProductEvent()`.
 *
 * Rejouable : le même envoi deux fois laisse la base telle quelle. Dolibarr
 * envoie souvent deux déclencheurs pour une seule modification
 * (`PRODUCT_MODIFY` puis `PRODUCT_PRICE_MODIFY`), parfois en même temps : une
 * course perdue sur un index unique est rejouée une fois.
 */

export type ProductOutcome =
  | { result: 'cree' | 'modifie' | 'inchange' | 'retire'; message: string }
  | { result: 'refuse'; message: string }

async function retryOnUnique<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (dbErrorCode(error) !== DB_UNIQUE_VIOLATION) throw error
    return run()
  }
}

/** Service vivant de ce code, verrouillé jusqu'à la fin de la transaction. */
async function livingService(tx: Transaction, code: string) {
  const [row] = await tx
    .select()
    .from(services)
    .where(and(eq(services.tenantId, currentTenantId()), eq(services.code, code), isNull(services.deletedAt)))
    .for('update')
  return row
}

/**
 * Crée, met à jour ou archive le service de ce code. Dolibarr fait foi : nom,
 * description, prix, TVA et mise en vente sont recopiés. La nature d'un
 * service existant ne change pas — elle décide de la manière dont il se
 * facture, et une souscription en cours en dépend.
 */
export function applyDolibarrService(product: ServiceFromDolibarr): Promise<ProductOutcome> {
  return retryOnUnique(() =>
    withTenant(currentTenantId(), async (tx) => {
      let current = await livingService(tx, product.code)
      if (!current && product.previousCode) {
        // Référence renommée dans Dolibarr : le service la suit plutôt que
        // d'en laisser un second sous l'ancien code.
        current = await livingService(tx, product.previousCode)
      }

      if (product.removed) {
        if (!current) return { result: 'inchange', message: `Aucun service « ${product.code} » à archiver.` }
        // Archivé (décision 6) : il rend son code, ce qui l'emploie reste lisible.
        await tx
          .update(services)
          .set({ deletedAt: maintenant(), isActive: false })
          .where(eq(services.id, current.id))
        return { result: 'retire', message: `Service « ${product.code} » archivé.` }
      }

      const values = {
        code: product.code,
        name: product.name,
        description: product.description,
        unitPriceCents: product.unitPriceCents,
        vatRateBp: product.vatRateBp,
        isActive: product.isActive,
      }
      if (!current) {
        await tx.insert(services).values({
          id: uuidv7(),
          ...values,
          nature: product.nature,
          unit: product.unit,
        })
        return { result: 'cree', message: `Service « ${product.code} » créé.` }
      }

      // Un acte se compte à l'unité (`services_act_per_unit`) : l'unité ne
      // change que pour un forfait.
      const unit = current.nature === 'act' ? 'unit' : product.unit === 'unit' ? current.unit : product.unit
      const unchanged =
        current.code === values.code &&
        current.name === values.name &&
        current.description === values.description &&
        current.unitPriceCents === values.unitPriceCents &&
        current.vatRateBp === values.vatRateBp &&
        current.isActive === values.isActive &&
        current.unit === unit
      if (unchanged) return { result: 'inchange', message: `Service « ${product.code} » déjà à jour.` }
      await tx
        .update(services)
        .set({ ...values, unit })
        .where(eq(services.id, current.id))
      return { result: 'modifie', message: `Service « ${product.code} » mis à jour.` }
    }),
  )
}

/**
 * Pose le prix reçu dans la grille par défaut en vigueur le jour `today` (jour
 * du centre). Un prix qui change n'est pas écrasé : l'ancien est retiré et le
 * nouveau ajouté, la ligne retirée explique les montants déjà calculés avec
 * elle (décision 6). Sans grille par défaut ce jour-là, rien n'est écrit : le
 * centre en crée une à l'écran Tarifs, puis Dolibarr renvoie le produit.
 */
export function applyDolibarrTariff(tariff: TariffFromDolibarr, today: string): Promise<ProductOutcome> {
  return retryOnUnique(() =>
    withTenant(currentTenantId(), async (tx) => {
      const tenantId = currentTenantId()
      const [plan] = await tx
        .select({ id: ratePlans.id, name: ratePlans.name })
        .from(ratePlans)
        .where(and(eq(ratePlans.tenantId, tenantId), defaultRatePlanOn(today)))
        .for('share')
      if (!plan) {
        return {
          result: 'refuse',
          message:
            `Aucune grille tarifaire par défaut en vigueur au ${today} : « ${tariff.ref} » n'a pas de grille où se poser. ` +
            'Créer la grille à l’écran Tarifs du site, puis enregistrer à nouveau le produit dans Dolibarr.',
        }
      }

      let resourceId: string | null = null
      if (tariff.resourceCode) {
        const [resource] = await tx
          .select({ id: resources.id })
          .from(resources)
          .where(
            and(
              eq(resources.tenantId, tenantId),
              eq(resources.resourceType, tariff.resourceType),
              sql`lower(${resources.code}) = ${tariff.resourceCode}`,
              isNull(resources.deletedAt),
            ),
          )
          .limit(1)
        if (!resource) {
          return {
            result: 'refuse',
            message: `Aucune ressource « ${tariff.resourceCode} » de type ${tariff.resourceType} sur le site, pour « ${tariff.ref} ».`,
          }
        }
        resourceId = resource.id
      }

      const [current] = await tx
        .select({ id: ratePlanItems.id, amountCents: ratePlanItems.amountCents })
        .from(ratePlanItems)
        .where(
          and(
            eq(ratePlanItems.ratePlanId, plan.id),
            eq(ratePlanItems.resourceType, tariff.resourceType),
            resourceId ? eq(ratePlanItems.resourceId, resourceId) : isNull(ratePlanItems.resourceId),
            eq(ratePlanItems.unit, tariff.unit),
            isNull(ratePlanItems.deletedAt),
          ),
        )
        .for('update')

      if (tariff.removed) {
        if (!current) return { result: 'inchange', message: `Aucun prix « ${tariff.ref} » dans « ${plan.name} ».` }
        await tx.update(ratePlanItems).set({ deletedAt: maintenant() }).where(eq(ratePlanItems.id, current.id))
        return { result: 'retire', message: `Prix « ${tariff.ref} » retiré de « ${plan.name} ».` }
      }
      if (current?.amountCents === tariff.amountCents) {
        return { result: 'inchange', message: `Prix « ${tariff.ref} » déjà à jour dans « ${plan.name} ».` }
      }
      if (current) {
        await tx.update(ratePlanItems).set({ deletedAt: maintenant() }).where(eq(ratePlanItems.id, current.id))
      }
      await tx.insert(ratePlanItems).values({
        id: uuidv7(),
        ratePlanId: plan.id,
        resourceType: tariff.resourceType,
        resourceId,
        unit: tariff.unit,
        amountCents: tariff.amountCents,
      })
      return {
        result: current ? 'modifie' : 'cree',
        message: `Prix « ${tariff.ref} » ${current ? 'mis à jour' : 'ajouté'} dans « ${plan.name} ».`,
      }
    }),
  )
}
