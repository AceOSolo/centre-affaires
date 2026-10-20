import { isIsoMonth, monthRangeUtc } from '../../../../../lib/dates.ts'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { listDoneRequests, listOpenings } from '../../../../../modules/courrier/queries.ts'
import { groupOpeningsByClient } from '../../../../../modules/courrier/regles.ts'
import { openingsToCsv } from '../../../../../modules/courrier/releve.ts'

/**
 * Export CSV du relevé mensuel, pour la facturation dans Dolibarr : les
 * ouvertures, les numérisations demandées et les réexpéditions du mois.
 */
export async function GET(request: Request) {
  await requirePermission('courrier.releve')
  const month = new URL(request.url).searchParams.get('mois') ?? undefined
  if (!isIsoMonth(month)) return new Response('Mois attendu : ?mois=AAAA-MM', { status: 400 })

  const timeZone = await currentTimeZone()
  const range = monthRangeUtc(month, timeZone)
  const [openings, requests] = await Promise.all([listOpenings(range), listDoneRequests(range)])
  const groups = groupOpeningsByClient(openings, requests)

  return new Response(openingsToCsv(groups, timeZone), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="releve-courrier-${month}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
