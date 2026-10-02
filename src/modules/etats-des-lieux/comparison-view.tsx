import { differenceSummary, isDifference, type ComparisonChange, type ComparisonRow } from './comparaison.ts'

/**
 * Comparaison sortie / entrée, côte à côte (R06, ADR 039). Chaque écart est
 * écrit — « Dégradé : Bon état → État d'usage » — et la ligne porte en plus
 * une marque « Écart » : la couleur ne fait que souligner (`CLAUDE.md`).
 *
 * `table` au back-office et à l'impression ; `cards` dans l'espace client,
 * lisible à 375 px.
 */
const changeStyles: Record<ComparisonChange, string> = {
  same: 'text-muted-foreground',
  empty: 'text-muted-foreground',
  worse: 'font-semibold text-foreground',
  better: 'font-medium text-foreground',
  changed: 'font-medium text-foreground',
  added: 'font-medium text-foreground',
  missing: 'font-medium text-foreground',
  entry_only: 'text-muted-foreground',
  exit_only: 'text-muted-foreground',
}

function Badge({ row }: { row: ComparisonRow }) {
  if (!isDifference(row)) return null
  return (
    <span
      className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
        row.change === 'worse'
          ? 'bg-primary text-primary-foreground'
          : 'border border-primary text-primary'
      }`}
    >
      {row.change === 'worse' ? 'Dégradation' : 'Écart'}
    </span>
  )
}

export function ComparisonView({
  rows,
  layout = 'table',
  entryLabel,
  exitLabel,
}: {
  rows: readonly ComparisonRow[]
  layout?: 'table' | 'cards'
  /** « Entrée du 12 janv. 2026 » */
  entryLabel: string
  exitLabel: string
}) {
  const summary = differenceSummary(rows)

  if (layout === 'cards') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{summary}</p>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.fieldId}
              className={`rounded-lg border bg-white p-4 ${isDifference(row) ? 'border-primary' : 'border-border'}`}
            >
              <p className="text-sm font-semibold">
                <Badge row={row} />
                {row.label}
              </p>
              <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Entrée</dt>
                <dd className="tabular">{row.entry ?? <span className="text-muted-foreground">Non renseigné</span>}</dd>
                <dt className="text-muted-foreground">Sortie</dt>
                <dd className="tabular">{row.exit ?? <span className="text-muted-foreground">Non renseigné</span>}</dd>
                <dt className="text-muted-foreground">Écart</dt>
                <dd className={changeStyles[row.change]}>{row.note}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{summary}</p>
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            Comparaison champ par champ : {entryLabel}, {exitLabel}, et l’écart constaté.
          </caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Champ</th>
              <th scope="col" className="px-4 py-3 font-medium">{entryLabel}</th>
              <th scope="col" className="px-4 py-3 font-medium">{exitLabel}</th>
              <th scope="col" className="px-4 py-3 font-medium">Écart</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={row.fieldId}
                className={isDifference(row) ? 'border-l-4 border-l-primary bg-muted' : undefined}
              >
                <th scope="row" className="px-4 py-3 font-medium">
                  {row.label}
                </th>
                <td className="px-4 py-3 tabular">
                  {row.entry ?? <span className="text-muted-foreground">Non renseigné</span>}
                </td>
                <td className="px-4 py-3 tabular">
                  {row.exit ?? <span className="text-muted-foreground">Non renseigné</span>}
                </td>
                <td className={`px-4 py-3 ${changeStyles[row.change]}`}>
                  <Badge row={row} />
                  {row.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
