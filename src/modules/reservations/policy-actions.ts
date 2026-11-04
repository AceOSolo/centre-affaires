'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { withTenant } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { parseMaxRequestDays } from './durees.ts'
import { validRequestPolicy } from './request-policy.ts'

export type PolicyFormState = { error?: string; fieldErrors?: Record<string, string>; saved?: boolean } | null

export async function saveRequestPolicyAction(_previous: PolicyFormState, formData: FormData): Promise<PolicyFormState> {
  await requirePermission('centre.configurer')
  const lead = String(formData.get('bookingLeadHours') ?? '').trim()
  const horizon = String(formData.get('bookingHorizonDays') ?? '').trim()
  const policy = { bookingLeadHours: Number(lead), bookingHorizonDays: Number(horizon) }
  if (!lead || !horizon || !validRequestPolicy(policy)) {
    return { error: 'Indiquez des nombres entiers : préavis positif ou nul, horizon de 1 à 365 jours. Le préavis doit être inférieur à l’horizon.' }
  }
  // Durée maximale d'une demande en ligne, par produit (ADR 061).
  const maxDays = parseMaxRequestDays(formData)
  if (!maxDays.ok) {
    return { error: 'Certaines durées maximales sont à corriger.', fieldErrors: maxDays.errors as Record<string, string> }
  }
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(tenants)
      .set({ ...policy, bookingMaxDays: maxDays.settings })
      .where(eq(tenants.id, currentTenantId())),
  )
  revalidatePath('/disponibilites')
  revalidatePath('/compte/reservations', 'layout')
  revalidatePath('/')
  return { saved: true }
}
