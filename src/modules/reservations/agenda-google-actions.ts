'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { parseKey } from '../../lib/chiffrement.ts'
import {
  AGENDAS_PATH,
  CALLBACK_PATH,
  OAUTH_COOKIE,
  authorizationUrl,
  checkGoogleClient,
  googleConfig,
  isGoogleClientId,
  isGoogleClientSecret,
  pkceChallenge,
  type GoogleConfig,
} from './agenda-google.ts'
import {
  backfillResourceCalendars,
  clearLeftCalendars,
  disconnectGoogleCalendar,
  googleCalendarStatus,
  loadGoogleConfig,
  saveGoogleClient,
  saveResourceCalendars,
  type CalendarChoice,
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
  const config = await loadGoogleConfig()
  if (!config) redirect(`${AGENDAS_PATH}?compte=non-configure`)
  await startConsent(config)
}

/** Retour du formulaire des identifiants : erreurs par champ, ou message d'ensemble. */
export type GoogleClientFormState = {
  message?: string
  fieldErrors?: Partial<Record<'clientId' | 'clientSecret', string>>
  values?: { clientId: string }
} | null

/**
 * Enregistre l'ID client et le code secret du centre (ADR 069), puis part
 * aussitôt chez Google : coller les identifiants et connecter le compte ne
 * font qu'un clic.
 *
 * Refusé tant qu'un compte est connecté : son jeton a été délivré à l'ancien
 * client, il ne se renouvellerait pas avec un autre.
 */
export async function saveGoogleClientAction(
  _previous: GoogleClientFormState,
  formData: FormData,
): Promise<GoogleClientFormState> {
  const { member } = await requirePermission('agenda-google.gerer')
  const clientId = String(formData.get('clientId') ?? '').trim()
  const clientSecret = String(formData.get('clientSecret') ?? '').trim()
  const values = { clientId }

  if (await googleCalendarStatus()) {
    return {
      message: 'Un compte Google est connecté : déconnectez-le avant de changer d’identifiants.',
      values,
    }
  }
  try {
    parseKey(process.env.SECRETS_ENCRYPTION_KEY)
  } catch {
    return {
      message:
        'Le serveur n’a pas de clé de chiffrement (SECRETS_ENCRYPTION_KEY) : le code secret ne peut pas être enregistré.',
      values,
    }
  }

  const fieldErrors: NonNullable<GoogleClientFormState>['fieldErrors'] = {}
  if (!isGoogleClientId(clientId)) {
    fieldErrors.clientId = 'Collez l’ID client en entier : il se termine par .apps.googleusercontent.com.'
  }
  if (!isGoogleClientSecret(clientSecret)) {
    fieldErrors.clientSecret = 'Collez le code secret du client tel que Google Cloud le donne, sans espace.'
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  const config = googleConfig(process.env, { clientId, clientSecret })
  if (!config) return { message: 'L’adresse du site (APP_URL) manque sur ce serveur.', values }
  if ((await checkGoogleClient(config)) === 'refuse') {
    return {
      fieldErrors: {
        clientSecret:
          'Google ne reconnaît pas cet ID client avec ce code secret. Recopiez-les depuis la page du client OAuth.',
      },
      values,
    }
  }

  await saveGoogleClient({ clientId, clientSecret }, member.id)
  revalidatePath(AGENDAS_PATH)
  return startConsent(config)
}

/**
 * Pose l'état et le vérificateur PKCE le temps de l'aller-retour, puis
 * redirige vers la page de consentement. Ne rend jamais la main.
 */
async function startConsent(config: GoogleConfig): Promise<never> {
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Les choix du formulaire : un champ `agenda:<ressource>` par ressource, vide
 * pour « aucun agenda », `NEW_CALENDAR` pour en créer un, sinon l'identifiant
 * d'un agenda du compte (vérifié par `saveResourceCalendars`).
 */
function calendarChoices(formData: FormData): CalendarChoice[] {
  const choices: CalendarChoice[] = []
  for (const [name, value] of formData.entries()) {
    const resourceId = name.startsWith('agenda:') ? name.slice('agenda:'.length) : ''
    if (!UUID.test(resourceId) || typeof value !== 'string') continue
    const calendarId = value.trim()
    if (calendarId.length > 255) continue
    choices.push({ resourceId, calendarId: calendarId || null })
  }
  return choices
}

/**
 * Enregistre l'agenda de chaque ressource (ADR 072), puis, après la réponse,
 * recopie les réservations à venir dans les agendas nouvellement choisis et
 * les retire des agendas quittés.
 */
export async function saveResourceCalendarsAction(formData: FormData): Promise<void> {
  await requirePermission('agenda-google.gerer')
  const { linked, left, changed, failed } = await saveResourceCalendars(calendarChoices(formData))
  after(() => clearLeftCalendars(left))
  after(() => backfillResourceCalendars(linked))
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?agendas=enregistres&n=${changed}&echecs=${failed}`)
}
