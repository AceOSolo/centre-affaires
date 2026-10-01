'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import {
  AGENDAS_PATH,
  CALLBACK_PATH,
  OAUTH_COOKIE,
  authorizationUrl,
  googleConfig,
  pkceChallenge,
} from './agenda-google.ts'
import {
  backfillResourceCalendars,
  createResourceCalendars,
  disconnectGoogleCalendar,
  removeResourceCalendars,
} from './agenda-google-queries.ts'

/*
 * Espace des agendas Google (ADR 014). Réservé aux administrateurs : connecter
 * un compte ou relier une salle, c'est décider où partent les réservations du
 * centre. Le contrôle vit dans chaque action, qui s'invoque depuis n'importe
 * quel chemin (ADR 008).
 */

/** Départ vers l'écran de consentement de Google. */
export async function connectGoogleCalendarAction(): Promise<void> {
  await requirePermission('agenda-google.gerer')
  const config = googleConfig()
  if (!config) redirect(`${AGENDAS_PATH}?compte=non-configure`)

  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const store = await cookies()
  store.set(OAUTH_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `lax` et non `strict` : le cookie doit revenir avec la redirection de
    // Google, qui est une navigation venue d'un autre site.
    sameSite: 'lax',
    path: CALLBACK_PATH,
    maxAge: 10 * 60,
  })
  redirect(authorizationUrl(config, { state, codeChallenge: pkceChallenge(verifier) }))
}

export async function disconnectGoogleCalendarAction(): Promise<void> {
  await requirePermission('agenda-google.gerer')
  await disconnectGoogleCalendar()
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?compte=deconnecte`)
}

function selectedResources(formData: FormData): string[] {
  return formData
    .getAll('resourceIds')
    .map(String)
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
}

/**
 * Crée l'agenda des ressources cochées, puis recopie leurs réservations à venir
 * après la réponse.
 */
export async function createResourceCalendarsAction(formData: FormData): Promise<void> {
  await requirePermission('agenda-google.gerer')
  const ids = selectedResources(formData)
  if (!ids.length) redirect(`${AGENDAS_PATH}?agendas=vide`)

  const { created, failed } = await createResourceCalendars(ids)
  after(() => backfillResourceCalendars(created))
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?agendas=crees&n=${created.length}&echecs=${failed}`)
}

export async function removeResourceCalendarsAction(formData: FormData): Promise<void> {
  await requirePermission('agenda-google.gerer')
  const ids = selectedResources(formData)
  if (!ids.length) redirect(`${AGENDAS_PATH}?agendas=vide`)

  const removed = await removeResourceCalendars(ids)
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?agendas=retires&n=${removed}`)
}
