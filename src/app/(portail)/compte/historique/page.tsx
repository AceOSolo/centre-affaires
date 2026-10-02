import Link from 'next/link'

import {
  BuildingIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CreditCardIcon,
  FileTextIcon,
  MailIcon,
} from '../../../../components/ui/icons.tsx'
import { formatDateTime, formatIsoMonth, toIsoDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import {
  buildAccountHistory,
  groupHistoryByMonth,
  historyCategories,
  historyCategoryLabels,
  isHistoryCategory,
  type HistoryCategory,
  type HistoryTone,
} from '../../../../modules/clients/historique-compte.ts'
import {
  findAccountHistoryStart,
  HISTORY_SOURCE_LIMIT,
  loadAccountHistory,
} from '../../../../modules/clients/historique-compte-queries.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'

export const metadata = { title: 'Historique du compte' }

const toneIcons: Record<HistoryTone, typeof CheckIcon> = {
  waiting: ClockIcon,
  progress: ClockIcon,
  done: CheckIcon,
  closed: CalendarIcon,
  due: CreditCardIcon,
}

/** Mêmes bleus que les réservations et les factures (ADR 004) ; le libellé porte le sens. */
const toneStyles: Record<HistoryTone, string> = {
  waiting: 'bg-accent/15 text-primary',
  progress: 'border border-primary bg-white text-primary',
  done: 'bg-primary text-primary-foreground',
  closed: 'bg-muted text-muted-foreground',
  due: 'border border-primary bg-white text-primary',
}

const categoryIcons: Record<HistoryCategory, typeof CheckIcon> = {
  reservations: CalendarIcon,
  courrier: MailIcon,
  contrats: FileTextIcon,
  factures: CreditCardIcon,
  'etats-des-lieux': BuildingIcon,
}

const YEAR = /^\d{4}$/

/** Lien de filtre : rubrique et année, l'une gardant l'autre. */
function historyHref(category: HistoryCategory | undefined, year: number, currentYear: number): string {
  const params = new URLSearchParams()
  if (category) params.set('type', category)
  if (year !== currentYear) params.set('annee', String(year))
  const query = params.toString()
  return query ? `/compte/historique?${query}` : '/compte/historique'
}

const filterClass = (active: boolean) =>
  `inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors ${
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border bg-white text-primary hover:bg-muted'
  }`

/**
 * Historique du compte (R24) : chaque demande et chaque document des
 * entreprises du compte, par mois, du plus récent au plus ancien — demandes
 * de réservation et leur issue, demandes de courrier et chacune de leurs
 * étapes, documents de contrat, factures et avoirs. Une annulation ne retire
 * rien : elle devient une étape.
 *
 * Par année du centre, pour que chaque année reste accessible sans liste sans
 * fin ; filtrable par rubrique. Mobile d'abord (R25).
 */
export default async function HistoriquePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; annee?: string }>
}) {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const { type, annee } = await searchParams
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const today = todayIsoDate(timeZone)
  const currentYear = Number(today.slice(0, 4))

  const start = await findAccountHistoryStart(accounts)
  const firstYear = start ? Math.min(Number(toIsoDate(start, timeZone).slice(0, 4)), currentYear) : currentYear
  const requested = annee && YEAR.test(annee) ? Number(annee) : currentYear
  const year = Math.min(Math.max(requested, firstYear), currentYear)
  const category = isHistoryCategory(type) ? type : undefined

  const { sources, truncated } = await loadAccountHistory(accounts, { year, timeZone, category })
  const entries = buildAccountHistory(sources, { timeZone, today })
  const months = groupHistoryByMonth(entries, timeZone)
  const years = Array.from({ length: currentYear - firstYear + 1 }, (_, index) => currentYear - index)
  const several = accounts.length > 1

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Historique du compte
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Chaque demande et chaque document, avec leur suite : une demande annulée ou refusée reste
          ici, datée, avec son motif.
        </p>
      </div>

      <div className="flex max-w-3xl flex-col gap-3">
        <nav aria-label="Rubriques de l’historique" className="flex flex-wrap gap-2">
          <Link
            href={historyHref(undefined, year, currentYear)}
            aria-current={category === undefined ? 'page' : undefined}
            className={filterClass(category === undefined)}
          >
            Tout
          </Link>
          {historyCategories.map((entry) => (
            <Link
              key={entry}
              href={historyHref(entry, year, currentYear)}
              aria-current={category === entry ? 'page' : undefined}
              className={filterClass(category === entry)}
            >
              {historyCategoryLabels[entry]}
            </Link>
          ))}
        </nav>
        {years.length > 1 && (
          <nav aria-label="Années" className="flex flex-wrap gap-2">
            {years.map((entry) => (
              <Link
                key={entry}
                href={historyHref(category, entry, currentYear)}
                aria-current={entry === year ? 'page' : undefined}
                className={`${filterClass(entry === year)} tabular`}
              >
                {entry}
              </Link>
            ))}
          </nav>
        )}
      </div>

      {/* Annoncé quand le filtre change. */}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {entries.length === 0
          ? ''
          : `${entries.length} élément${entries.length > 1 ? 's' : ''} en ${year}${category ? `, rubrique ${historyCategoryLabels[category].toLowerCase()}` : ''}.`}
      </p>

      {truncated && (
        <p role="status" className="max-w-prose rounded-md bg-muted px-4 py-3 text-sm">
          Seuls les {HISTORY_SOURCE_LIMIT} éléments les plus récents de chaque rubrique sont
          affichés pour {year}. Choisissez une rubrique pour affiner, ou demandez un relevé complet
          au centre.
        </p>
      )}

      {entries.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <ClockIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Rien en {year}
            {category ? ` dans la rubrique ${historyCategoryLabels[category].toLowerCase()}` : ''}.
            Vos demandes de réservation et de courrier, vos contrats et vos factures apparaîtront
            ici au fil de l’eau.
          </p>
          <div className="mt-4 flex flex-col justify-center gap-2 sm:flex-row">
            <Link
              href="/compte/reservations"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium text-primary transition-colors hover:bg-muted"
            >
              Mes réservations
            </Link>
            <Link
              href="/compte/courrier"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium text-primary transition-colors hover:bg-muted"
            >
              Mon courrier
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex max-w-3xl flex-col gap-8">
          {months.map((group) => (
            <section key={group.month} aria-labelledby={`mois-${group.month}`} className="flex flex-col gap-3">
              <h2 id={`mois-${group.month}`} className="text-lg font-semibold capitalize">
                {formatIsoMonth(group.month)}
              </h2>
              <ol className="flex flex-col gap-3">
                {group.entries.map((entry) => {
                  const ToneIcon = toneIcons[entry.outcome.tone]
                  const CategoryIcon = categoryIcons[entry.category]
                  const titleId = `entree-${entry.key.replace(/[^a-zA-Z0-9-]/g, '-')}`
                  return (
                    <li key={entry.key} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                      <article aria-labelledby={titleId} className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
                            <CategoryIcon size={16} />
                            {historyCategoryLabels[entry.category]}
                          </span>
                          {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${toneStyles[entry.outcome.tone]}`}
                          >
                            <ToneIcon size={16} />
                            {entry.outcome.label}
                          </span>
                          {several && <span className="text-muted-foreground">· {entry.clientName}</span>}
                        </div>

                        <div>
                          <h3 id={titleId} className="text-base font-semibold">
                            {entry.title}
                          </h3>
                          {entry.detail && (
                            <p className="text-sm text-muted-foreground first-letter:uppercase">{entry.detail}</p>
                          )}
                        </div>

                        <ol className="flex flex-col gap-1 border-l-2 border-border pl-3 text-sm">
                          {entry.steps.map((step, index) => (
                            <li key={index}>
                              {step.label}
                              {step.at && (
                                <>
                                  {' '}
                                  <span className="text-muted-foreground">
                                    le{' '}
                                    <time dateTime={step.at.toISOString()} className="tabular">
                                      {formatDateTime(step.at, timeZone)}
                                    </time>
                                  </span>
                                </>
                              )}
                            </li>
                          ))}
                        </ol>

                        {entry.notes.map((note) => (
                          <p key={note} className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">
                            {note}
                          </p>
                        ))}

                        {entry.link && (
                          <Link
                            href={entry.link.href}
                            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted sm:self-start"
                          >
                            {entry.link.label}
                            <span className="sr-only"> — {entry.title}</span>
                          </Link>
                        )}
                      </article>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
