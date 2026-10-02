'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { PG_CHECK_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { defaultTemplates } from './catalogue.ts'
import { findTemplateState, saveTemplate } from './queries.ts'
import { validateTemplate, type TemplateErrors } from './rendu.ts'
import { notificationEvents, type NotificationEvent } from './schema.ts'

/*
 * Actions des modèles de messages (R26, ADR 038). Réservées à l'exploitant
 * (`notifications.gerer`) : chacune vérifie son droit elle-même, une action
 * serveur s'invoque par son identifiant depuis n'importe quel chemin (ADR 008,
 * ADR 019).
 */

export type TemplateFormState = {
  fieldErrors?: TemplateErrors
  /** Refus qui ne tient à aucun champ. */
  error?: string
  values?: { subject: string; body: string; active: boolean }
  /** Enregistré : la page le dit. */
  saved?: boolean
} | null

function readEvent(formData: FormData): NotificationEvent | undefined {
  const event = String(formData.get('event') ?? '')
  return (notificationEvents as readonly string[]).includes(event) ? (event as NotificationEvent) : undefined
}

const templatePath = (event: NotificationEvent) => `/notifications/modeles/${event}`

/** Enregistre l'objet, le texte et l'activation du modèle d'un événement. */
export async function saveTemplateAction(
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const { member } = await requirePermission('notifications.gerer')
  const event = readEvent(formData)
  if (!event) return { error: 'Message inconnu.' }

  const values = {
    // L'objet tient sur une ligne : un retour collé d'un traitement de texte
    // n'en fait pas une erreur.
    subject: String(formData.get('subject') ?? '').replace(/[\r\n]+/g, ' ').trim(),
    body: String(formData.get('body') ?? '').replace(/\r\n?/g, '\n').trim(),
    active: formData.get('active') === 'on',
  }
  const fieldErrors = validateTemplate(event, values)
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  try {
    await saveTemplate(event, values, member.id)
  } catch (error) {
    if (pgErrorCode(error) === PG_CHECK_VIOLATION) {
      return { error: 'La base a refusé ce modèle : objet ou texte vide, ou trop long.', values }
    }
    throw error
  }
  revalidatePath('/notifications/modeles')
  revalidatePath(templatePath(event))
  return { saved: true, values }
}

/**
 * Revient au texte par défaut du code : la ligne est réécrite avec lui (le
 * modèle ne se supprime pas, ADR 038). L'activation reste celle choisie.
 */
export async function resetTemplateAction(
  _previous: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string } | null> {
  const { member } = await requirePermission('notifications.gerer')
  const event = readEvent(formData)
  if (!event) return { error: 'Message inconnu.' }
  const current = await findTemplateState(event)
  if (current.stored) {
    await saveTemplate(event, { ...defaultTemplates[event], active: current.active }, member.id)
  }
  revalidatePath('/notifications/modeles')
  revalidatePath(templatePath(event))
  redirect(`${templatePath(event)}?fait=reinitialise&v=${Date.now()}`)
}
