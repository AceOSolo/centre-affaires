import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import {
  addMonthsToIsoMonth,
  formatDateTime,
  formatIsoMonth,
  isIsoMonth,
  monthRangeUtc,
  todayIsoDate,
} from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { mailKindLabels, openingOriginLabels } from '../../../../modules/courrier/labels.ts'
import { listOpenings } from '../../../../modules/courrier/queries.ts'
import { groupOpeningsByClient, openingOrigin } from '../../../../modules/courrier/regles.ts'

export const metadata = { title: 'Relevé des ouvertures' }

/**
 * Relevé mensuel des ouvertures de courrier, par client. Depuis la facturation
 * intégrée (ADR 026, 028), ce n'est plus la source de facturation : chaque pli
 * ouvert devient une ligne de la facture du client, par le lot du mois. Le
 * relevé et son export restent un contrôle (ADR 015).
 */
export default async function OuverturesPage({
  searchParams,
}: {
  searchParams: Promise<{ mois?: string }>
}) {
  await requirePermission('courrier.releve')
  const { mois } = await searchParams
  const timeZone = await currentTimeZone()
  const month = isIsoMonth(mois) ? mois : todayIsoDate(timeZone).slice(0, 7)

  const groups = groupOpeningsByClient(await listOpenings(monthRangeUtc(month, timeZone)))
  const total = groups.reduce((sum, group) => sum + group.total, 0)
  const byClient = groups.reduce((sum, group) => sum + group.requestedByClient, 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          ← Courrier
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Relevé des ouvertures — {formatIsoMonth(month)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Chaque pli ouvert et numérisé dans le mois, par client. Heures en {timeZone}.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Un contrôle, pas la source de facturation : les plis ouverts sont facturés par le lot
          mensuel, sur la facture de chaque client.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Link
          href={`/courrier/ouvertures?mois=${addMonthsToIsoMonth(month, -1)}`}
          className="rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted"
        >
          ← {formatIsoMonth(addMonthsToIsoMonth(month, -1))}
        </Link>
        <Link
          href={`/courrier/ouvertures?mois=${addMonthsToIsoMonth(month, 1)}`}
          className="rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted"
        >
          {formatIsoMonth(addMonthsToIsoMonth(month, 1))} →
        </Link>
        {/* Formulaire GET : le mois reste dans l'URL et le relevé se partage. */}
        <form className="flex items-end gap-2">
          <div>
            <label htmlFor="mois" className="block text-xs font-medium text-muted-foreground">
              Mois
            </label>
            <input
              id="mois"
              name="mois"
              type="month"
              defaultValue={month}
              className="mt-1 rounded-sm border border-border bg-white px-3 py-1.5 text-sm"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted"
          >
            Afficher
          </button>
        </form>
        {total > 0 && (
          <a
            href={`/courrier/ouvertures/export?mois=${month}`}
            className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Exporter pour la facturation (CSV)
          </a>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucune ouverture de courrier en {formatIsoMonth(month)}.
          </p>
          <Link
            href="/courrier/demandes?nature=ouverture"
            className="mt-4 inline-block text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Voir les demandes d’ouverture à traiter
          </Link>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Nombre d’ouvertures par client</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 text-right font-medium">Ouvertures</th>
                  <th className="px-4 py-3 text-right font-medium">Demandées par le client</th>
                  <th className="px-4 py-3 text-right font-medium">À l’initiative du centre</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {groups.map((group) => (
                  <tr key={group.clientId}>
                    <td className="px-4 py-3">
                      <a href={`#client-${group.clientId}`} className="underline-offset-2 hover:underline">
                        {group.clientName}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular">{group.total}</td>
                    <td className="px-4 py-3 text-right tabular">{group.requestedByClient}</td>
                    <td className="px-4 py-3 text-right tabular">
                      {group.total - group.requestedByClient}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border font-medium">
                <tr>
                  <th scope="row" className="px-4 py-3">
                    Total
                  </th>
                  <td className="px-4 py-3 text-right tabular">{total}</td>
                  <td className="px-4 py-3 text-right tabular">{byClient}</td>
                  <td className="px-4 py-3 text-right tabular">{total - byClient}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {groups.map((group) => (
            <section key={group.clientId} id={`client-${group.clientId}`} className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold tracking-tight">
                <Link href={`/clients/${group.clientId}`} className="underline-offset-2 hover:underline">
                  {group.clientName}
                </Link>{' '}
                <span className="font-normal text-muted-foreground">
                  ({group.total} ouverture{group.total > 1 ? 's' : ''})
                </span>
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Ouvert le</th>
                      <th className="px-4 py-3 font-medium">Origine</th>
                      <th className="px-4 py-3 font-medium">Demandé par</th>
                      <th className="px-4 py-3 font-medium">Ouvert par</th>
                      <th className="px-4 py-3 font-medium">Pli</th>
                      <th className="px-4 py-3 font-medium">Reçu le</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {group.lines.map((line) => (
                      <tr key={line.mailItemId}>
                        <td className="whitespace-nowrap px-4 py-3 tabular">
                          <Link
                            href={`/courrier/${line.mailItemId}`}
                            className="underline-offset-2 hover:underline"
                          >
                            {formatDateTime(line.openedAt, timeZone)}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{openingOriginLabels[openingOrigin(line)]}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {line.requestedBy ? (
                            <>
                              {line.requestedBy}
                              <span className="block text-xs tabular">
                                {line.openingRequestedAt &&
                                  formatDateTime(line.openingRequestedAt, timeZone)}
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{line.openedBy ?? '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {mailKindLabels[line.kind]}
                          {line.sender && ` — ${line.sender}`}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground tabular">
                          {formatDateTime(line.receivedAt, timeZone)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
