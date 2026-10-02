import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'
import { findResource } from '../../../../../modules/ressources/queries.ts'
import { ResourceForm } from '../../../../../modules/ressources/resource-form.tsx'

export const metadata = { title: 'Modifier la ressource' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Modification d'une ressource (R01) : nom, code, capacité, état, attributs
 * propres au type et description. Une ressource archivée ne se modifie plus.
 */
export default async function EditResourcePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('ressources.gerer')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const resource = await findResource(id)
  if (!resource) notFound()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/ressources/${resource.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {resource.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modifier la ressource</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {resource.code} · {resourceTypeLabels[resource.resourceType]}
        </p>
      </div>
      {resource.deletedAt ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          Cette ressource est archivée : elle reste consultable mais ne se modifie plus.{' '}
          <Link href="/ressources/nouvelle" className="underline underline-offset-2">
            Déclarer une nouvelle ressource
          </Link>
        </p>
      ) : (
        <ResourceForm resource={resource} />
      )}
    </div>
  )
}
