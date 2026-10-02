import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { toEditorFields } from '../../../../../modules/etats-des-lieux/champs.ts'
import { fieldTypeLabels } from '../../../../../modules/etats-des-lieux/labels.ts'
import { defaultTemplates } from '../../../../../modules/etats-des-lieux/modeles-defaut.ts'
import { findTemplateOverview } from '../../../../../modules/etats-des-lieux/queries.ts'
import { TemplateEditor } from '../../../../../modules/etats-des-lieux/template-editor.tsx'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'
import { resourceTypes, type ResourceType } from '../../../../../modules/ressources/schema.ts'

export const metadata = { title: 'Modèle d’état des lieux' }

/**
 * Modèle d'état des lieux d'un type de ressource : l'éditeur de la version en
 * vigueur, et l'historique des versions publiées, chacune consultable.
 */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>
  searchParams: Promise<{ fait?: string; numero?: string; version?: string }>
}) {
  await requirePermission('etats-des-lieux.modeles')
  const { type } = await params
  const { fait, numero, version } = await searchParams
  if (!(resourceTypes as readonly string[]).includes(type)) notFound()
  const resourceType = type as ResourceType
  const [overview, timeZone] = await Promise.all([
    findTemplateOverview(resourceType),
    currentTimeZone(),
  ])

  const fallback = defaultTemplates[resourceType]
  const shown = version
    ? overview.versions.find((candidate) => String(candidate.version) === version)
    : undefined
  if (version && !shown) notFound()

  const notice =
    fait === 'published'
      ? `Version ${numero ?? ''} publiée. Les prochains états des lieux de ce type la suivront ; ceux déjà saisis gardent la leur.`
      : fait === 'renamed'
        ? 'Nom du modèle enregistré. Les champs n’ayant pas changé, aucune version n’a été publiée.'
        : fait === 'unchanged'
          ? 'Rien n’a changé : aucune version n’a été publiée.'
          : undefined

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/etats-des-lieux/modeles" className="text-sm text-muted-foreground hover:underline">
          ← Modèles d’état des lieux
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Modèle — {resourceTypeLabels[resourceType]}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {overview.current
            ? `Version ${overview.current.version} en vigueur, publiée le ${formatDateTime(overview.current.createdAt, timeZone)}.`
            : 'Aucune version publiée : le modèle de départ ci-dessous sera publié à la première saisie, ou dès maintenant si vous le publiez.'}
        </p>
      </div>

      {notice && <FlashNotice key={`${fait}-${numero}`}>{notice}</FlashNotice>}

      {shown ? (
        <section aria-labelledby="version-titre" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="version-titre" className="mr-auto text-lg font-semibold tracking-tight">
              Version {shown.version}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                publiée le {formatDateTime(shown.createdAt, timeZone)}
                {shown.createdByName ? ` par ${shown.createdByName}` : ''}
              </span>
            </h2>
            <Link
              href={`/etats-des-lieux/modeles/${resourceType}`}
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Revenir à l’édition
            </Link>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Libellé</th>
                  <th scope="col" className="px-4 py-3 font-medium">Type</th>
                  <th scope="col" className="px-4 py-3 font-medium">Obligatoire</th>
                  <th scope="col" className="px-4 py-3 font-medium">Précisions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.fields.map((field) => (
                  <tr key={field.id}>
                    <th scope="row" className="px-4 py-3 font-medium">
                      {field.label}
                      <span className="block text-xs font-normal text-muted-foreground">{field.id}</span>
                    </th>
                    <td className="px-4 py-3">{fieldTypeLabels[field.type]}</td>
                    <td className="px-4 py-3">{field.required ? 'Oui' : 'Non'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {[
                        field.unit ? `Unité : ${field.unit}` : null,
                        field.options ? `Options : ${field.options.join(', ')}` : null,
                        field.help ?? null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <TemplateEditor
          // Remonté à chaque version publiée : les champs ajoutés y reçoivent leur identifiant.
          key={overview.current?.id ?? 'depart'}
          resourceType={resourceType}
          initialName={overview.template?.name ?? fallback.name}
          initialFields={toEditorFields(overview.current?.fields ?? fallback.fields)}
          published={overview.template !== null}
        />
      )}

      <section aria-labelledby="historique-titre" className="flex flex-col gap-3">
        <h2 id="historique-titre" className="text-sm font-semibold tracking-tight">
          Versions publiées <span className="font-normal text-muted-foreground">({overview.versions.length})</span>
        </h2>
        {overview.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune encore. La première publication crée la version 1.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Version</th>
                  <th scope="col" className="px-4 py-3 font-medium">Publiée le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Par</th>
                  <th scope="col" className="px-4 py-3 font-medium">Champs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {overview.versions.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 tabular">
                      <Link
                        href={`/etats-des-lieux/modeles/${resourceType}?version=${row.version}`}
                        aria-current={shown?.id === row.id ? 'page' : undefined}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        Version {row.version}
                      </Link>
                      {row.id === overview.current?.id && (
                        <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
                          En vigueur
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular">{formatDateTime(row.createdAt, timeZone)}</td>
                    <td className="px-4 py-3">
                      {row.createdByName ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 tabular">{row.fields.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
