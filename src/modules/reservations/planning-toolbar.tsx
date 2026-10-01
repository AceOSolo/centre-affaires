import Link from 'next/link'

import { resourceTypeLabels } from '../ressources/labels.ts'
import { resourceTypes } from '../ressources/schema.ts'
import {
  planningHref,
  planningViewLabels,
  planningViews,
  type PlanningFilters,
  type PlanningView,
} from './filtres.ts'

/** Lien de navigation dans le temps : veille, semaine suivante, mois précédent… */
export type PeriodLink = { date: string; label: string }

const chip =
  'rounded-md border px-3 py-1 text-sm transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const chipIdle = 'border-border text-muted-foreground hover:bg-muted'
const chipActive = 'border-primary bg-primary text-white'
const control =
  'rounded-sm border border-border bg-white px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

/**
 * Barre commune aux trois vues du planning (R03, ADR 017) : échelle, période,
 * filtres.
 *
 * Rendue sur le serveur, sans JavaScript : la bascule et la navigation sont des
 * liens, les filtres un formulaire GET. Chaque lien garde le jour affiché et
 * les filtres, si bien qu'on change d'échelle sans refaire son tri.
 */
export function PlanningToolbar({
  view,
  date,
  filters,
  clients,
  ressource,
  previous,
  current,
  next,
}: {
  view: PlanningView
  /** Jour affiché, qui ancre la semaine et le mois. */
  date: string
  filters: PlanningFilters
  clients: { id: string; name: string }[]
  /** Ressource suivie en vue semaine détaillée (ADR 011). */
  ressource?: string
  previous: PeriodLink
  current: PeriodLink & { active: boolean }
  next: PeriodLink
}) {
  const link = (target: PlanningView, day: string) =>
    planningHref(target, { ...filters, date: day, ressource })
  const hasFilter = Boolean(filters.type || filters.client)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Échelle du planning" className="flex gap-1 rounded-md border border-border bg-white p-1">
          {planningViews.map((target) => (
            <Link
              key={target}
              href={planningHref(target, { ...filters, date })}
              aria-current={target === view ? 'page' : undefined}
              className={`rounded-sm px-3 py-1 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                target === view ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {planningViewLabels[target]}
            </Link>
          ))}
        </nav>

        <nav aria-label="Période" className="flex flex-wrap items-center gap-2">
          <Link href={link(view, previous.date)} className={`${chip} ${chipIdle}`}>
            ← {previous.label}
          </Link>
          <Link
            href={link(view, current.date)}
            aria-current={current.active ? 'date' : undefined}
            className={`${chip} ${current.active ? chipActive : chipIdle}`}
          >
            {current.label}
          </Link>
          <Link href={link(view, next.date)} className={`${chip} ${chipIdle}`}>
            {next.label} →
          </Link>
        </nav>
      </div>

      {/* Formulaire GET : filtrer et sauter à une date marchent sans
          JavaScript, et l'adresse obtenue se partage. */}
      <form
        role="search"
        aria-label="Filtrer le planning"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-white px-4 py-3"
      >
        {ressource && <input type="hidden" name="ressource" value={ressource} />}
        <div>
          <label htmlFor="planning-date" className="block text-xs text-muted-foreground">
            Jour
          </label>
          <input
            id="planning-date"
            name="date"
            type="date"
            defaultValue={date}
            className={`${control} mt-1 tabular`}
          />
        </div>
        <div>
          <label htmlFor="planning-type" className="block text-xs text-muted-foreground">
            Type de ressource
          </label>
          <select
            id="planning-type"
            name="type"
            defaultValue={filters.type ?? ''}
            className={`${control} mt-1`}
          >
            <option value="">Tous les types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {resourceTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="planning-client" className="block text-xs text-muted-foreground">
            Client
          </label>
          <select
            id="planning-client"
            name="client"
            defaultValue={filters.client ?? ''}
            aria-describedby="planning-client-hint"
            className={`${control} mt-1 max-w-56`}
          >
            <option value="">Tous les clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md border border-primary px-3 py-1 text-sm font-medium text-primary transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Afficher
        </button>
        {hasFilter && (
          <Link
            href={planningHref(view, { date, ressource })}
            className="py-1 text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Retirer les filtres
          </Link>
        )}
        <p id="planning-client-hint" className="basis-full text-xs text-muted-foreground">
          Le client choisi est mis en avant et pré-rempli dans les nouvelles réservations ; les
          créneaux des autres restent visibles, marqués « Occupé ».
        </p>
      </form>
    </div>
  )
}
