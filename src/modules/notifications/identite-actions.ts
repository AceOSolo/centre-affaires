'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { DB_CHECK_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { tenants, type EmailLogo } from '../../db/tenants.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { parseEmailIdentity } from './identite.ts'
import { checkEmailLogo, emailLogoKey } from './logo-courriels.ts'

/*
 * Logo et signature des courriels (Configuration, ADR 080). Réservés à qui
 * configure le centre (`centre.configurer`, ADR 019) ; chaque action revérifie
 * le droit, une action serveur s'invoquant depuis n'importe quel chemin.
 */

export type IdentityFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
  saved?: boolean
} | null

export type LogoFormState = { error?: string; saved?: 'depose' | 'retire' } | null

function revalidate(): void {
  revalidatePath('/configuration')
  // Le nom, le téléphone et le site s'affichent aussi sur le site public et
  // dans la coque du back-office.
  revalidatePath('/', 'layout')
}

/** Nom du centre, téléphone, site et lignes de signature. */
export async function saveEmailIdentityAction(
  _previous: IdentityFormState,
  formData: FormData,
): Promise<IdentityFormState> {
  await requirePermission('centre.configurer')
  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  }
  const result = parseEmailIdentity(values)
  if (!result.ok) return { fieldErrors: result.fieldErrors, values }

  const tenantId = currentTenantId()
  try {
    await withTenant(tenantId, (tx) => tx.update(tenants).set(result.update).where(eq(tenants.id, tenantId)))
  } catch (error) {
    if (dbErrorCode(error) === DB_CHECK_VIOLATION) {
      return { error: 'Valeur refusée par la base : vérifiez la saisie.', values }
    }
    throw error
  }
  revalidate()
  return { saved: true }
}

/**
 * Dépose le logo des courriels. Le fichier va dans le stockage européen, puis
 * la ligne du centre le désigne. L'ancien logo n'est pas effacé : les
 * courriels déjà reçus l'affichent encore.
 */
export async function uploadEmailLogoAction(_previous: LogoFormState, formData: FormData): Promise<LogoFormState> {
  await requirePermission('centre.configurer')
  const file = formData.get('logo')
  if (!file || typeof file === 'string' || file.size === 0) {
    return { error: 'Aucun fichier reçu : choisissez le fichier du logo.' }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { logo, error } = checkEmailLogo(bytes)
  if (!logo) return { error: error ?? 'Fichier refusé.' }

  const tenantId = currentTenantId()
  const id = uuidv7()
  const key = emailLogoKey(tenantId, id, logo.contentType)
  try {
    await putObject(key, bytes, logo.contentType)
  } catch (cause) {
    console.error('Logo des courriels non déposé', cause)
    return { error: 'Le stockage des fichiers ne répond pas. Réessayez dans un instant.' }
  }

  const emailLogo: EmailLogo = { id, key, byteSize: bytes.byteLength, ...logo }
  await withTenant(tenantId, (tx) => tx.update(tenants).set({ emailLogo }).where(eq(tenants.id, tenantId)))
  revalidate()
  return { saved: 'depose' }
}

/** Retire le logo des courriels : ils reprennent le logo du site. */
export async function removeEmailLogoAction(): Promise<LogoFormState> {
  await requirePermission('centre.configurer')
  const tenantId = currentTenantId()
  await withTenant(tenantId, (tx) => tx.update(tenants).set({ emailLogo: null }).where(eq(tenants.id, tenantId)))
  revalidate()
  return { saved: 'retire' }
}
