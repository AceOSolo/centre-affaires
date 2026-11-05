import { calendarForToken } from '../../../../modules/reservations/agenda-ics-queries.ts'

/**
 * Lien d'agenda d'une ressource (ADR 071), lu sans session par Google Agenda,
 * Apple Calendrier ou Outlook :
 *
 *   GET /api/agendas/{jeton}.ics
 *
 * Le jeton tient lieu de mot de passe. Inconnu, régénéré ou désactivé : 404,
 * sans rien dire de plus.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jeton: string }> }) {
  const { jeton } = await params
  const token = jeton.toLowerCase().replace(/\.ics$/, '')
  const calendar = await calendarForToken(token)
  if (calendar === undefined) return new Response('Agenda introuvable.', { status: 404 })

  return new Response(calendar, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="agenda.ics"',
      // Toujours relu en base : une réservation annulée ne doit pas rester
      // dans un cache intermédiaire.
      'cache-control': 'private, no-cache',
      'x-robots-tag': 'noindex',
    },
  })
}
