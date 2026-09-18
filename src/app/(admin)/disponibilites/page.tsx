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
  CopierHorairesForm,
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

  // Chaque ressource porte ses propres horaires (ADR 012). Celles qui suivent
  // encore le centre sont des ressources déclarées avant cette décision : elles
  // sont listées comme les autres, avec ce qu'elles héritent, et le bouton de
  // reprise les bascule.
  const avecHorairesPropres = new Set(particulieres.map((rule) => rule.resourceId))
  const actives = resources.filter((resource) => resource.status === 'active')
  const aReprendre = actives.filter((resource) => !avecHorairesPropres.has(resource.id)).length

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Disponibilités</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Chaque ressource a ses propres heures d’ouverture et ses propres fermetures. Le
          planning et le site public s’y réfèrent : une ressource hors ouverture n’est
          proposée nulle part.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            Horaires du centre — modèle des nouvelles ressources
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Heures murales, fixes toute l’année : elles ne bougent pas aux changements
            d’heure, contrairement aux instants qu’elles désignent.
          </p>
          {/* Le piège de l'ADR 012, dit à l'endroit où on s'y ferait prendre. */}
          <p className="mt-2 rounded-md border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
            Ces horaires servent de modèle à toute ressource nouvellement déclarée.{' '}
            <strong className="font-medium text-foreground">
              Les modifier ne change rien aux ressources existantes
            </strong>{' '}
            : chacune porte les siens et se règle dans la section suivante.
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

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Horaires par ressource</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Une ressource qui a ses propres plages ignore entièrement celles du centre. Pour
            changer les horaires d’une salle, c’est ici — et seulement ici.
          </p>
        </div>

        {actives.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Aucune ressource en service : il n’y a pas d’horaire à régler.
            </p>
            <Link
              href="/ressources/nouvelle"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Déclarer une ressource
            </Link>
          </div>
        ) : (
          actives.map((resource) => {
            const propres = particulieres.filter((rule) => rule.resourceId === resource.id)
            const suitLeCentre = propres.length === 0
            return (
              <div key={resource.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium">
                    {resource.name}{' '}
                    <span className="font-normal text-muted-foreground">
                      ({resource.code} · {resourceTypeLabels[resource.resourceType]})
                    </span>
                  </h3>
                  {/* Jamais la couleur seule : l'état est écrit en toutes lettres. */}
                  <span className="text-xs text-muted-foreground">
                    {suitLeCentre ? 'Suit les horaires du centre' : 'Horaires propres'}
                  </span>
                  <Link
                    href={`/reservations/semaine?ressource=${resource.id}`}
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    Voir sa semaine
                  </Link>
                </div>
                <WeekTable
                  rules={suitLeCentre ? centre : propres}
                  emptyLabel="Fermé"
                  action={suitLeCentre ? undefined : removeOpeningHourAction}
                />
              </div>
            )
          })
        )}

        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <h3 className="text-sm font-medium">Reprendre les ressources héritées</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Les ressources déclarées avant ce réglage suivent encore le centre. Cette reprise
            leur donne une copie de ses horaires, qu’elles porteront ensuite seules. Les
            ressources déjà réglées ne sont pas touchées.
          </p>
          <div className="mt-4">
            <CopierHorairesForm aReprendre={aReprendre} />
          </div>
        </div>
      </section>

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
  // Absente quand les plages affichées ne sont pas celles de la ligne : une
  // ressource qui suit le centre montre les horaires du centre, et on ne les
  // supprime pas depuis là — ce serait les retirer à tout le monde.
  action?: (formData: FormData) => Promise<void>
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
                          {action && (
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
                          )}
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
