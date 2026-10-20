'use server'

import { revalidatePath } from 'next/cache'

import { withTenant } from '../../db/index.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenantId, currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  attachAccountToClient,
  attachRefusalMessages,
  banAccounts,
  banRefusalMessages,
  liftBans,
  type BanRefusal,
} from './comptes.ts'
import { readBanForm, type BanFormErrors, type BanFormValues } from './regles.ts'

/**
 * Actions de l'écran Comptes (ADR 045), réservées au droit `comptes.gerer`.
 * Chacune revérifie le droit : une action serveur s'invoque par son
 * identifiant, depuis n'importe quelle page (ADR 008).
 */

/** Identifiants de comptes cochés ou portés par un champ caché. */
function readIds(formData: FormData): string[] {
  return [...new Set(formData.getAll('ids').map(String))].filter((id) => isUuid(id))
}

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`

export type BanFormState = {
  ok?: string
  /** Comptes non bannis, avec la raison : la sélection n'est pas tout ou rien. */
  refused?: { label: string; message: string }[]
  error?: string
  fieldErrors?: BanFormErrors
  values?: BanFormValues
} | null

export async function banAccountsAction(
  _previous: BanFormState,
  formData: FormData,
): Promise<BanFormState> {
  const { user, member } = await requirePermission('comptes.gerer')
  const ids = readIds(formData)
  const values: BanFormValues = {
    reason: String(formData.get('reason') ?? ''),
    duration: String(formData.get('duration') ?? ''),
    until: String(formData.get('until') ?? ''),
  }
  if (ids.length === 0) return { error: 'Cochez au moins un compte.', values }

  const read = readBanForm(values, await currentTimeZone())
  if ('errors' in read) return { fieldErrors: read.errors, values }

  const outcomes = await withTenant(currentTenantId(), (tx) =>
    banAccounts(tx, {
      actor: { memberId: member.id, authUserId: user.id },
      authUserIds: ids,
      ban: read.input,
    }),
  )
  revalidatePath('/comptes', 'layout')

  const banned = outcomes.filter((outcome) => outcome.refusal === null).length
  const labels = new Map(formData.getAll('labels').map(String).map((entry) => {
    const [id, ...rest] = entry.split('|')
    return [id, rest.join('|')] as const
  }))
  const refused = outcomes
    .filter((outcome): outcome is { authUserId: string; refusal: BanRefusal } => outcome.refusal !== null)
    .map((outcome) => ({
      label: labels.get(outcome.authUserId) ?? 'Un compte',
      message: banRefusalMessages[outcome.refusal],
    }))
  return {
    ok: banned > 0 ? `${plural(banned, 'compte banni', 'comptes bannis')} : leurs sessions sont fermées.` : undefined,
    refused,
  }
}

export type SimpleState = { ok?: string; error?: string } | null

export async function liftBansAction(_previous: SimpleState, formData: FormData): Promise<SimpleState> {
  const { member } = await requirePermission('comptes.gerer')
  const ids = readIds(formData)
  if (ids.length === 0) return { error: 'Cochez au moins un compte.' }

  const lifted = await withTenant(currentTenantId(), (tx) =>
    liftBans(tx, { actorMemberId: member.id, authUserIds: ids }),
  )
  revalidatePath('/comptes', 'layout')
  if (lifted.length === 0) return { error: 'Aucun de ces comptes n’était banni.' }
  return { ok: `${plural(lifted.length, 'compte réactivé', 'comptes réactivés')} : la connexion leur est rouverte.` }
}

export type AttachFormState = {
  ok?: string
  fieldErrors?: { clientId?: string }
} | null

export async function attachAccountAction(
  _previous: AttachFormState,
  formData: FormData,
): Promise<AttachFormState> {
  await requirePermission('comptes.gerer')
  const authUserId = String(formData.get('id') ?? '')
  const clientId = String(formData.get('clientId') ?? '')
  if (!isUuid(clientId)) return { fieldErrors: { clientId: 'Choisissez une entreprise.' } }
  if (!isUuid(authUserId)) return { fieldErrors: { clientId: attachRefusalMessages.introuvable } }

  const result = await withTenant(currentTenantId(), (tx) =>
    attachAccountToClient(tx, { authUserId, clientId }),
  )
  if (!result.ok) return { fieldErrors: { clientId: attachRefusalMessages[result.refusal] } }

  revalidatePath('/comptes', 'layout')
  revalidatePath(`/clients/${clientId}`)
  return { ok: `Le compte a maintenant accès à l’espace de ${result.clientName}.` }
}
