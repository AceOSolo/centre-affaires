'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { PG_CHECK_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import {
  parseBankDetails,
  parseInvoicingRules,
  parsePricingRules,
  parseSellerIdentity,
  type SettingsInput,
  type SettingsResult,
} from './parametres.ts'

/**
 * État rendu aux formulaires de configuration : erreurs par champ (affichées
 * à côté et reprises en tête), saisie rendue après un échec, succès.
 */
export type SettingsFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
  saved?: boolean
} | null

/**
 * Enregistre une section des paramètres du centre (R10). Les contraintes de
 * `tenants` restent l'autorité : un refus de la base est rendu tel quel.
 *
 * Chaque action ci-dessous revérifie le droit avant de l'appeler : réservé à
 * l'exploitant, une action serveur s'invoquant depuis n'importe quel chemin
 * (ADR 008, ADR 019).
 */
async function saveSection(
  parse: (input: SettingsInput) => SettingsResult,
  formData: FormData,
): Promise<SettingsFormState> {
  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  }
  const result = parse(values)
  if (!result.ok) return { fieldErrors: result.fieldErrors, values }

  try {
    await withTenant(currentTenantId(), (tx) =>
      tx.update(tenants).set(result.update).where(eq(tenants.id, currentTenantId())),
    )
  } catch (error) {
    if (pgErrorCode(error) === PG_CHECK_VIOLATION) {
      return { error: 'Valeur refusée par la base : vérifiez la saisie.', values }
    }
    throw error
  }

  revalidatePath('/configuration')
  // L'identité du centre s'affiche aussi sur le site public et dans la coque.
  revalidatePath('/', 'layout')
  return { saved: true }
}

/** Prorata, unité entamée, demi-journée, TVA par défaut (ADR 023). */
export async function savePricingRulesAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requirePermission('centre.configurer')
  return saveSection(parsePricingRules, formData)
}

/** Échéance, moment de facturation, mentions obligatoires (ADR 026). */
export async function saveInvoicingRulesAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requirePermission('centre.configurer')
  return saveSection(parseInvoicingRules, formData)
}

/** Identité légale du vendeur, figée dans chaque facture émise (ADR 026). */
export async function saveSellerIdentityAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requirePermission('centre.configurer')
  return saveSection(parseSellerIdentity, formData)
}

/** Coordonnées bancaires du vendeur et mode de paiement par défaut (ADR 027). */
export async function saveBankDetailsAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requirePermission('centre.configurer')
  return saveSection(parseBankDetails, formData)
}
