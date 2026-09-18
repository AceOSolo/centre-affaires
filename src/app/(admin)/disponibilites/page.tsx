import Link from 'next/link'

import { todayIsoDate } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import {
  formatWallTime,
  resourceTypeLabels,
  weekdayLabels,
  weekdays,
} from '../../../modules/ressources/labels.ts'
import {
  removeClosureAction,
  removeOpeningHourAction,
} from '../../../modules/ressources/ouverture-actions.ts'
import {
  ClosureForm,
  OpeningHourForm,
  WeekScheduleForm,
} from '../../../modules/ressources/ouverture-forms.tsx'
import {
  listOpeningHours,
  listUpcomingClosures,
} from '../../../modules/ressources/ouverture-queries.ts'
import { listResources } from '../../../modules/ressources/queries.ts'

export const metadata = { title: 'Disponibilités' }

export default async function DisponibilitesPage() {
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)

  const [rules, closures, resources] = await Promise.all([
    listOpeningHours(),
    listUpcomingClosures(today),
    listResources(),
  ])

  const byResource = new Map(resources.map((resource) => [resource.id, resource]))
  const centre = rules.filter((rule) => rule.resourceId === null)
  const particulieres = rules.filter((rule) => rule.resourceId !== null)

  // Une ressource qui a ses propres horaires ignore entièrement ceux du centre :
  // le dire ici évite de chercher pourquoi une salle est fermée un mardi.
  const resourcesAvecHoraires = [...new Set(particulieres.map((rule) => rule.resourceId))]

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Disponibilités</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Heures d’ouverture et fermetures exceptionnelles. Le planning et le site public
          s’y réfèrent : une ressource hors ouverture n’est proposée nulle part.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Horaires du centre</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Heures murales, fixes toute l’année : elles ne bougent pas aux changements
            d’heure, contrairement aux instants qu’elles désignent.
          </p>
        </div>

        {centre.length === 0 ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Aucun horaire d’ouverture : le centre est fermé tous les jours, et le site
            public n’affiche aucun créneau.
          </p>
        ) : (
          <WeekTable
            rules={centre}
            emptyLabel="Fermé"
            action={removeOpeningHourAction}
          />
        )}

        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <h3 className="text-sm font-medium">Appliquer une semaine type</h3>
          <div className="mt-4">
            <WeekScheduleForm resources={resources} />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <h3 className="text-sm font-medium">Ajouter une plage</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Une coupure de midi se saisit en deux plages : 09:00–12:30 et 14:00–18:00.
          </p>
          <div className="mt-4">
            <OpeningHourForm resources={resources} />
          </div>
        </div>
      </section>

      {resourcesAvecHoraires.length > 0 && (
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Horaires particuliers</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Ces ressources ignorent les horaires du centre et suivent uniquement les
              leurs.
            </p>
          </div>

          {resourcesAvecHoraires.map((resourceId) => {
            const resource = resourceId ? byResource.get(resourceId) : undefined
            return (
              <div key={resourceId} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">
                  {resource
                    ? `${resource.name} (${resource.code} · ${resourceTypeLabels[resource.resourceType]})`
                    : 'Ressource archivée'}
                </h3>
                <WeekTable
                  rules={particulieres.filter((rule) => rule.resourceId === resourceId)}
                  emptyLabel="Fermé"
                  action={removeOpeningHourAction}
                />
              </div>
            )
          })}
        </section>
      )}

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Fermetures exceptionnelles</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Journées entières. Une indisponibilité de quelques heures relève du statut de
            la ressource ou d’une réservation de blocage.
          </p>
        </div>

        {closures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune fermeture à venir.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Période</th>
                  <th className="px-4 py-3 font-medium">Portée</th>
                  <th className="px-4 py-3 font-medium">Motif</th>
                  <th className="px-4 py-3 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {closures.map((closure) => {
                  const resource = closure.resourceId ? byResource.get(closure.resourceId) : undefined
                  return (
                    <tr key={closure.id}>
                      <td className="whitespace-nowrap px-4 py-3">
                        {closure.startsOn}
                        {closure.endsOn !== closure.startsOn && ` → ${closure.endsOn}`}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {resource ? `${resource.code} — ${resource.name}` : 'Tout le centre'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{closure.reason ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <form action={removeClosureAction}>
                          <input type="hidden" name="id" value={closure.id} />
                          <button
                            type="submit"
                            className="text-xs text-destructive underline-offset-2 hover:underline"
                          >
                            Retirer
                          </button>
                        </form>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <h3 className="text-sm font-medium">Ajouter une fermeture</h3>
          <div className="mt-4">
            <ClosureForm resources={resources} />
          </div>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Les changements sont pris en compte immédiatement sur le{' '}
        <Link href="/reservations" className="underline underline-offset-2">
          planning
        </Link>{' '}
        et sur le site public.
      </p>
    </div>
  )
}

/** Une ligne par jour de la semaine, avec ses plages. */
function WeekTable({
  rules,
  emptyLabel,
  action,
}: {
  rules: { id: string; weekday: number; opensAt: string; closesAt: string }[]
  emptyLabel: string
  action: (formData: FormData) => Promise<void>
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-border">
          {weekdays.map((jour) => {
            const plages = rules.filter((rule) => rule.weekday === jour)
            return (
              <tr key={jour}>
                <th scope="row" className="w-32 px-4 py-2.5 text-left font-medium">
                  {weekdayLabels[jour]}
                </th>
                <td className="px-4 py-2.5">
                  {plages.length === 0 ? (
                    <span className="text-muted-foreground">{emptyLabel}</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {plages.map((plage) => (
                        <span
                          key={plage.id}
                          className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-0.5 text-xs tabular-nums"
                        >
                          {formatWallTime(plage.opensAt)} – {formatWallTime(plage.closesAt)}
                          <form action={action}>
                            <input type="hidden" name="id" value={plage.id} />
                            <button
                              type="submit"
                              aria-label={`Retirer la plage ${formatWallTime(plage.opensAt)} – ${formatWallTime(plage.closesAt)} du ${weekdayLabels[jour].toLowerCase()}`}
                              className="text-destructive hover:underline"
                            >
                              ×
                            </button>
                          </form>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
