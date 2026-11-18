'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { withTenant } from '../../db/index.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { acceptsRentalFormulas, describeFormulas, parseFormulas } from './formules.ts'
import { resources } from './schema.ts'

/** Réponse rendue au formulaire, annoncée au lecteur d'écran. */
export type RentalFormulasState = { ok?: string; error?: string } | null

/**
 * Formules de location d'un bureau (ADR 076), réglées sur sa fiche : rangées
 * dans `attributes.formules`, les autres attributs intacts. Aucune formule
 * cochée : le formulaire libre d'avant (début, fin, tarif le moins cher).
 */
export async function updateRentalFormulasAction(
  _previous: RentalFormulasState,
  formData: FormData,
): Promise<RentalFormulasState> {
  await requirePermission('ressources.gerer')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return { error: 'Cette ressource n’existe pas ou a été archivée.' }
  const formulas = parseFormulas(formData)
  const tenantId = currentTenantId()

  const saved = await withTenant(tenantId, async (tx) => {
    const [resource] = await tx
      .select({ resourceType: resources.resourceType, attributes: resources.attributes })
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1)
    if (!resource || !acceptsRentalFormulas(resource.resourceType)) return false
    const attributes = { ...((resource.attributes ?? {}) as Record<string, unknown>) }
    if (formulas.length > 0) attributes.formules = formulas
    else delete attributes.formules
    await tx
      .update(resources)
      .set({ attributes: attributes as typeof resource.attributes })
      .where(and(eq(resources.tenantId, tenantId), eq(resources.id, id)))
    return true
  })
  if (!saved) return { error: 'Seul un bureau en service se règle par formules.' }

  revalidatePath(`/ressources/${id}`)
  revalidatePath('/compte/reservations', 'layout')
  revalidatePath('/')
  return {
    ok:
      formulas.length > 0
        ? `Formules enregistrées : ${describeFormulas(formulas)}.`
        : 'Aucune formule : le formulaire de demande reste libre (début et fin au choix).',
  }
}
