import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { defaultTemplates } from '../../../../modules/etats-des-lieux/modeles-defaut.ts'
import { listTemplateOverviews } from '../../../../modules/etats-des-lieux/queries.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Modèles d’état des lieux' }

/**
 * Modèles de formulaire d'état des lieux, un par type de ressource (R06,
 * ADR 039), réservés à l'exploitant. Un type sans modèle publié utilise son
 * modèle de départ.
 */
export default async function TemplatesPage() {
  await requirePermission('etats-des-lieux.modeles')
  const [overviews, timeZone] = await Promise.all([listTemplateOverviews(), currentTimeZone()])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/etats-des-lieux" className="text-sm text-muted-foreground hover:underline">
          ← États des lieux
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modèles d’état des lieux</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les champs à relever pour chaque type de ressource : kilométrage et carburant d’un
          véhicule, état général et clés d’un bureau. Chaque modification publie une nouvelle
          version ; un état des lieux garde celle avec laquelle il a été saisi.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Type de ressource</th>
              <th scope="col" className="px-4 py-3 font-medium">Modèle</th>
              <th scope="col" className="px-4 py-3 font-medium">Version en vigueur</th>
              <th scope="col" className="px-4 py-3 font-medium">Champs</th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {overviews.map((overview) => (
              <tr key={overview.resourceType}>
                <th scope="row" className="px-4 py-3 font-medium">
                  {resourceTypeLabels[overview.resourceType]}
                </th>
                <td className="px-4 py-3">
                  {overview.template ? (
                    overview.template.name
                  ) : (
                    <span className="text-muted-foreground">
                      Modèle de départ — pas encore publié
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 tabular">
                  {overview.current ? (
                    <>
                      Version {overview.current.version}
                      <span className="block text-xs text-muted-foreground">
                        Publiée le {formatDateTime(overview.current.createdAt, timeZone)}
                        {overview.current.createdByName ? ` par ${overview.current.createdByName}` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Aucune</span>
                  )}
                </td>
                <td className="px-4 py-3 tabular">
                  {(overview.current?.fields ?? defaultTemplates[overview.resourceType].fields).length}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/etats-des-lieux/modeles/${overview.resourceType}`}
                    aria-label={`Modifier le modèle ${resourceTypeLabels[overview.resourceType]}`}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {overview.template ? 'Modifier' : 'Ajuster et publier'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
