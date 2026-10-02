'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { PG_CHECK_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clientMembers } from '../clients/schema.ts'
import {
  anonymizeClientMemberOnRequest,
  anonymizeClientOnRequest,
  anonymizeStaffMemberOnRequest,
  recordLastContact,
} from './anonymisation.ts'
import { parseLastContact } from './dernier-contact.ts'
import {
  parseRetentionDurations,
  retentionDurations,
  shortenedRetentions,
  type RetentionKey,
} from './durees.ts'

/*
 * Actions du RGPD (R29, ADR 040). Chacune revérifie son droit : une action
 * serveur s'invoque par son identifiant, depuis n'importe quel chemin
 * (ADR 008, ADR 019).
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

/* ------------------------------------------------------------------------ */
/* Durées de conservation                                                   */
/* ------------------------------------------------------------------------ */

export type RetentionFormState = {
  error?: string
  fieldErrors?: Partial<Record<RetentionKey, string>>
  values?: Record<string, string>
  /** Durées raccourcies, à confirmer avant d'enregistrer. */
  confirmShortening?: RetentionKey[]
  /** Enregistré ; les durées raccourcies s'appliquent dès la nuit suivante. */
  saved?: { shortened: RetentionKey[] }
} | null

/**
 * Enregistre les durées de conservation du centre. Raccourcir une durée
 * efface ou anonymise, dès la tâche de nuit suivante, ce qui dépasse la
 * nouvelle durée — données déjà présentes comprises, sans retour possible :
 * l'écran le fait confirmer avant d'écrire.
 */
export async function saveRetentionDurationsAction(
  _previous: RetentionFormState,
  formData: FormData,
): Promise<RetentionFormState> {
  await requirePermission('centre.configurer')
  const values: Record<string, string> = {}
  for (const { key } of retentionDurations) values[key] = text(formData, key)

  const result = parseRetentionDurations(values)
  if (!result.ok) return { fieldErrors: result.fieldErrors, values }

  const shortened = shortenedRetentions(await currentTenant(), result.update)
  if (shortened.length > 0 && formData.get('confirmShortening') !== 'on') {
    return { confirmShortening: shortened, values }
  }

  try {
    await withTenant(currentTenantId(), (tx) =>
      tx.update(tenants).set(result.update).where(eq(tenants.id, currentTenantId())),
    )
  } catch (error) {
    if (pgErrorCode(error) === PG_CHECK_VIOLATION) {
      return { error: 'Durée refusée par la base : de 1 à 120 mois.', values }
    }
    throw error
  }
  revalidatePath('/configuration')
  return { saved: { shortened } }
}

/* ------------------------------------------------------------------------ */
/* Dernier contact                                                          */
/* ------------------------------------------------------------------------ */

export type LastContactFormState = { error?: string; value?: string; saved?: boolean } | null

/** Note le dernier contact de l'équipe avec l'entreprise (fiche client). */
export async function recordLastContactAction(
  _previous: LastContactFormState,
  formData: FormData,
): Promise<LastContactFormState> {
  await requirePermission('clients.gerer')
  const clientId = text(formData, 'clientId')
  if (!isUuid(clientId)) return { error: 'Fiche introuvable.' }
  const value = text(formData, 'lastContactOn')
  const tenant = await currentTenant()
  const parsed = parseLastContact(value, todayIsoDate(tenant.timezone))
  if (!parsed.ok) return { error: parsed.error, value }

  if (!(await recordLastContact(clientId, parsed.date))) {
    return { error: 'Cette fiche est anonymisée : elle ne change plus.', value }
  }
  revalidatePath(`/clients/${clientId}`)
  return { saved: true }
}

/* ------------------------------------------------------------------------ */
/* Anonymisation à la demande                                               */
/* ------------------------------------------------------------------------ */

export type AnonymizeState = { error?: string } | null

/**
 * Droit à l'effacement d'une entreprise : anonymise sa fiche, ses contacts,
 * ses accès et leurs traces, sans attendre la durée de conservation. Refusé,
 * avec la liste des exclusions, tant qu'une facture n'est pas soldée, qu'un
 * contrat vit encore, etc. Les factures émises ne sont jamais touchées.
 */
export async function anonymizeClientAction(
  _previous: AnonymizeState,
  formData: FormData,
): Promise<AnonymizeState> {
  await requirePermission('rgpd.anonymiser')
  const clientId = text(formData, 'clientId')
  if (!isUuid(clientId)) return { error: 'Fiche introuvable.' }

  const outcome = await anonymizeClientOnRequest(clientId)
  if (!outcome.ok) return { error: outcome.reason }

  revalidatePath('/clients')
  revalidatePath(`/clients/${clientId}`)
  redirect(`/clients/${clientId}?rgpd=anonymise#conservation`)
}

/**
 * Une personne dont l'accès à l'espace client a été retiré demande
 * l'effacement : son nom et son adresse partent sans attendre la durée. Un
 * accès encore ouvert se retire d'abord.
 */
export async function anonymizeClientMemberAction(
  _previous: AnonymizeState,
  formData: FormData,
): Promise<AnonymizeState> {
  await requirePermission('rgpd.anonymiser')
  const memberId = text(formData, 'memberId')
  if (!isUuid(memberId)) return { error: 'Accès introuvable.' }

  // L'entreprise vient de la base, pas du formulaire : c'est elle qu'on
  // rouvre ensuite.
  const [member] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ clientId: clientMembers.clientId })
      .from(clientMembers)
      .where(eq(clientMembers.id, memberId))
      .limit(1),
  )
  if (!member) return { error: 'Accès introuvable.' }

  const outcome = await anonymizeClientMemberOnRequest(memberId)
  if (!outcome.ok) return { error: outcome.reason }

  revalidatePath(`/clients/${member.clientId}`)
  redirect(`/clients/${member.clientId}?rgpd=acces-anonymise#conservation`)
}

/** Même chose pour un membre retiré de l'équipe (écran « Équipe »). */
export async function anonymizeStaffMemberAction(
  _previous: AnonymizeState,
  formData: FormData,
): Promise<AnonymizeState> {
  await requirePermission('rgpd.anonymiser')
  const staffMemberId = text(formData, 'staffMemberId')
  if (!isUuid(staffMemberId)) return { error: 'Membre introuvable.' }

  const outcome = await anonymizeStaffMemberOnRequest(staffMemberId)
  if (!outcome.ok) return { error: outcome.reason }

  revalidatePath('/equipe')
  redirect('/equipe?anonymise=1#retires')
}
