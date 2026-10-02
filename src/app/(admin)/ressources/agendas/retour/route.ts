import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'

import { requireAdmin } from '../../../../../lib/auth/staff.ts'
import {
  AGENDAS_PATH,
  CALLBACK_PATH,
  OAUTH_COOKIE,
} from '../../../../../modules/reservations/agenda-google.ts'
import { completeGoogleCalendarConnection } from '../../../../../modules/reservations/agenda-google-queries.ts'

/**
 * Retour de Google après le consentement (ADR 014). L'adresse doit être
 * déclarée à l'identique dans la console Google Cloud : `APP_URL` suivi de
 * `CALLBACK_PATH`.
 */
export async function GET(request: NextRequest) {
  const { member } = await requireAdmin()

  const store = await cookies()
  const pending = store.get(OAUTH_COOKIE)?.value
  // À usage unique : un retour rejoué ne trouve plus de quoi se valider.
  store.delete({ name: OAUTH_COOKIE, path: CALLBACK_PATH })

  const outcome = await completeGoogleCalendarConnection(
    request.nextUrl.searchParams,
    pending,
    member.id,
  )
  // Hors de tout try : `redirect` interrompt par une exception.
  redirect(`${AGENDAS_PATH}?compte=${outcome}`)
}
