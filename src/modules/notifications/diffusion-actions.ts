'use server'

import { createHash } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { appUrl, emailEnabled } from '../../lib/courriel.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { notificationEventLabels } from './catalogue.ts'
import {
  createBroadcast,
  EmptyBroadcastError,
  findBroadcast,
  previewBroadcast,
  sendBroadcast,
} from './diffusion.ts'
import {
  broadcastProgress,
  readBroadcastInput,
  type BroadcastAudience,
  type BroadcastErrors,
  type BroadcastInput,
} from './diffusion-regles.ts'
import { findTemplateState } from './queries.ts'
import { renderMessage } from './rendu.ts'

/**
 * Message groupé aux clients (ADR 060), en deux temps : l'aperçu, qui dit
 * à combien d'entreprises et de personnes il partira, puis la confirmation,
 * qui l'enregistre et lance l'envoi par paquets après la réponse.
 *
 * Réservé au droit `notifications.diffuser` (exploitant et direction) : un
 * message à tous les domiciliés engage le centre.
 */

export type BroadcastFormValues = Pick<BroadcastInput, 'target' | 'clientIds' | 'subject' | 'body'>

export type BroadcastFormState = {
  error?: string
  fieldErrors?: BroadcastErrors
  values?: BroadcastFormValues
  preview?: {
    /** Le message tel que la première entreprise le recevra. */
    subject: string
    body: string
    audience: BroadcastAudience
    sample: string[]
    /** Empreinte de ce qui a été montré : la confirmation la compare. */
    digest: string
    /** Ce qui empêcherait le message de partir : modèle désactivé, SMTP absent. */
    warnings: string[]
  }
  /** L'aperçu a changé depuis celui qui a été confirmé. */
  notice?: string
} | null

/** Empreinte du message et de ses destinataires, telle que l'aperçu les a montrés. */
function digestOf(input: BroadcastInput, audience: BroadcastAudience): string {
  return createHash('sha256')
    .update(JSON.stringify([input.target, [...input.clientIds].sort(), input.subject, input.body, audience.companies]))
    .digest('hex')
}

export async function broadcastAction(
  _previous: BroadcastFormState,
  formData: FormData,
): Promise<BroadcastFormState> {
  const { member } = await requirePermission('notifications.diffuser')
  const { input, errors } = readBroadcastInput({
    target: formData.get('target'),
    clientIds: formData.getAll('clients'),
    subject: formData.get('subject'),
    body: formData.get('body'),
  })
  const values: BroadcastFormValues = input
  if (Object.keys(errors).length > 0) return { fieldErrors: errors, values }

  const { audience, sample } = await previewBroadcast(input)
  if (audience.companies === 0) {
    return {
      fieldErrors: {
        target:
          input.target === 'selection'
            ? 'Les entreprises cochées ne sont plus dans la liste des clients.'
            : 'Aucune entreprise n’a aujourd’hui de contrat en cours pour ce choix.',
      },
      values,
    }
  }

  const [tenant, template] = await Promise.all([currentTenant(), findTemplateState('client_broadcast')])
  const rendered = renderMessage(
    template,
    {
      centre: tenant.name,
      client: sample[0],
      objet: input.subject,
      message: input.body,
      lien: appUrl('/compte/preferences'),
    },
    notificationEventLabels.client_broadcast,
  )
  const warnings: string[] = []
  if (!template.active) {
    warnings.push(
      'Le modèle « Message du centre aux clients » est désactivé dans les modèles de messages : rien ne partira.',
    )
  }
  if (!emailEnabled()) {
    warnings.push('Les courriels ne sont pas configurés (SMTP) : l’envoi sera journalisé, mais rien ne partira.')
  }
  const digest = digestOf(input, audience)
  const preview = { ...rendered, audience, sample, digest, warnings }

  if (formData.get('intent') !== 'envoyer') return { preview, values }
  if (String(formData.get('digest') ?? '') !== digest) {
    return {
      preview,
      values,
      notice: 'Le message ou ses destinataires ont changé depuis l’aperçu : relisez-le, puis confirmez de nouveau.',
    }
  }

  let id: string
  try {
    ;({ id } = await createBroadcast(input, member.id))
  } catch (error) {
    if (error instanceof EmptyBroadcastError) return { error: error.message, values }
    console.error('Message aux clients non enregistré', error)
    return { error: 'Le message n’a pas pu être enregistré. Réessayez dans un instant.', values }
  }
  // Après la réponse : l'envoi par paquets prend du temps, l'écran suit son
  // avancement. Le centre est fixé ici, pas relu hors de la requête.
  const tenantId = currentTenantId()
  after(() => sendBroadcast(id, { tenantId }))
  revalidatePath('/messages')
  redirect(`/messages/${id}?envoi=lance`)
}

/**
 * Reprend un envoi interrompu (serveur redémarré pendant les paquets) : les
 * entreprises déjà servies ne reçoivent rien de plus.
 */
export async function resumeBroadcastAction(formData: FormData): Promise<void> {
  await requirePermission('notifications.diffuser')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) redirect('/messages')
  const broadcast = await findBroadcast(id)
  if (!broadcast) redirect('/messages')
  if (broadcastProgress(broadcast.tally, broadcast.lastActivity, new Date()) === 'stalled') {
    const tenantId = currentTenantId()
    after(() => sendBroadcast(id, { tenantId }))
  }
  revalidatePath(`/messages/${id}`)
  redirect(`/messages/${id}?envoi=repris`)
}
