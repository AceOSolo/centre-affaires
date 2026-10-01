import Link from 'next/link'

import { requirePermission } from '../../../lib/auth/staff.ts'
import {
  archiveResourceAction,
  updateResourceStatusAction,
} from '../../../modules/ressources/actions.ts'
import {
  describeAttributes,
  resourceStatusLabels,
  resourceStatusStyles,
  resourceTypeLabels,
} from '../../../modules/ressources/labels.ts'
import { listResources } from '../../../modules/ressources/queries.ts'
import { resourceTypes, type ResourceType } from '../../../modules/ressources/schema.ts'

export const metadata = { title: 'Ressources' }

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  await requirePermission('ressources.gerer')
  const { type } = await searchParams
  const filter = resourceTypes.includes(type as ResourceType) ? (type as ResourceType) : undefined
  const resources = await listResources({ resourceType: filter })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ressources</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Salles, bureaux, casiers, véhicules et boîtes aux lettres du centre.
          </p>
        </div>
        <Link
          href="/ressources/nouvelle"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Nouvelle ressource
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterLink href="/ressources" label="Tous les types" active={!filter} />
        {resourceTypes.map((resourceType) => (
          <FilterLink
            key={resourceType}
            href={`/ressources?type=${resourceType}`}
            label={resourceTypeLabels[resourceType]}
            active={filter === resourceType}
          />
        ))}
      </div>

      {resources.length === 0 ? (
        <EmptyState filtered={Boolean(filter)} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Nom</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Capacité</th>
                <th className="px-4 py-3 font-medium">État</th>
                <th className="px-4 py-3 font-medium sr-only">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {resources.map((resource) => {
                const details = describeAttributes(resource.attributes ?? {})
                return (
                  <tr key={resource.id}>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {resource.code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{resource.name}</div>
                      {details && (
                        <div className="text-xs text-muted-foreground">{details}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {resourceTypeLabels[resource.resourceType]}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {resource.capacity ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${resourceStatusStyles[resource.status]}`}
                      >
                        {resourceStatusLabels[resource.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-3 text-xs">
                        <form action={updateResourceStatusAction}>
                          <input type="hidden" name="id" value={resource.id} />
                          <input
                            type="hidden"
                            name="status"
                            value={resource.status === 'active' ? 'maintenance' : 'active'}
                          />
                          <button
                            type="submit"
                            className="text-muted-foreground underline-offset-2 hover:underline"
                          >
                            {resource.status === 'active' ? 'Mettre en maintenance' : 'Remettre en service'}
                          </button>
                        </form>
                        {/* Archivage et non suppression : une ressource retirée
                            reste lisible depuis ses réservations (décision 6). */}
                        <form action={archiveResourceAction}>
                          <input type="hidden" name="id" value={resource.id} />
                          <button
                            type="submit"
                            className="text-destructive underline-offset-2 hover:underline"
                          >
                            Archiver
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
 active
 ? 'border-primary bg-primary text-white'
 : 'border-border text-muted-foreground hover:border-border'
 }`}
    >
      {label}
    </Link>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">
        {filtered
          ? 'Aucune ressource de ce type.'
          : "Aucune ressource pour l'instant. Le planning se remplira une fois les premières salles déclarées."}
      </p>
      <Link
        href="/ressources/nouvelle"
        className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
      >
        Déclarer une ressource
      </Link>
    </div>
  )
}
