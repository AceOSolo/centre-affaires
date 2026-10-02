import { isIsoMonth, monthRangeUtc } from '../../../../../lib/dates.ts'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { listOpenings } from '../../../../../modules/courrier/queries.ts'
import { groupOpeningsByClient } from '../../../../../modules/courrier/regles.ts'
import { openingsToCsv } from '../../../../../modules/courrier/releve.ts'

/** Export CSV du relevé mensuel, pour la facturation. */
export async function GET(request: Request) {
  await requirePermission('courrier.releve')
  const month = new URL(request.url).searchParams.get('mois') ?? undefined
  if (!isIsoMonth(month)) return new Response('Mois attendu : ?mois=AAAA-MM', { status: 400 })

  const timeZone = await currentTimeZone()
  const groups = groupOpeningsByClient(await listOpenings(monthRangeUtc(month, timeZone)))

  return new Response(openingsToCsv(groups, timeZone), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ouvertures-courrier-${month}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
