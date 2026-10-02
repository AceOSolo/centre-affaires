import Link from 'next/link'

import { FlashNotice } from '../../../components/ui/flash-notice.tsx'
import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import {
  inspectionKindLabels,
  inspectionStageLabels,
  inspectionStageStyles,
} from '../../../modules/etats-des-lieux/labels.ts'
import { listInspections, type InspectionFilter } from '../../../modules/etats-des-lieux/queries.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'

export const metadata = { title: 'États des lieux' }

const filters: { value: NonNullable<InspectionFilter['stage']> | 'tous'; label: string }[] = [
  { value: 'tous', label: 'Tous' },
  { value: 'draft', label: 'En saisie' },
  { value: 'to_sign', label: 'À valider par le client' },
  { value: 'signed', label: 'Validés' },
]

/**
 * États des lieux du centre (R06, ADR 039) : ceux en saisie d'abord dans
 * l'esprit, filtrables par étape. Ils s'ouvrent depuis la fiche d'une
 * ressource, d'une réservation ou d'un contrat.
 */
export default async function InspectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ etape?: string; fait?: string }>
}) {
  const { member } = await requirePermission('etats-des-lieux.gerer')
  const { etape, fait } = await searchParams
  const stage = filters.find((filter) => filter.value === etape && filter.value !== 'tous')
    ?.value as InspectionFilter['stage']
  const [rows, timeZone] = await Promise.all([listInspections({ stage }), currentTimeZone()])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">États des lieux</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Entrées et sorties des ressources occupées. Un état des lieux s’ouvre depuis la fiche de la
            ressource, de la réservation ou du contrat ; une fois clos, le client le valide dans son
            espace.
          </p>
        </div>
        {can(member.role, 'etats-des-lieux.modeles') && (
          <Link
            href="/etats-des-lieux/modeles"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted"
          >
            Modèles de formulaire
          </Link>
        )}
      </div>

      {fait === 'retire' && (
        <FlashNotice key={fait}>Brouillon retiré : il n’apparaît plus dans la liste.</FlashNotice>
      )}

      <nav aria-label="Filtrer par étape" className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const active = (stage ?? 'tous') === filter.value
          return (
            <Link
              key={filter.value}
              href={filter.value === 'tous' ? '/etats-des-lieux' : `/etats-des-lieux?etape=${filter.value}`}
              aria-current={active ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors duration-150 ease-out ${
                active
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-white text-foreground hover:bg-muted'
              }`}
            >
              {filter.label}
            </Link>
          )
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-10 text-center text-sm text-muted-foreground">
          <p>
            {stage
              ? 'Aucun état des lieux à cette étape.'
              : 'Aucun état des lieux pour l’instant.'}
          </p>
          <p className="mt-2">
            Pour en ouvrir un, allez sur la fiche d’une{' '}
            <Link href="/ressources" className="font-medium text-primary underline-offset-2 hover:underline">
              ressource
            </Link>
            , d’une réservation ou d’un{' '}
            <Link href="/contrats" className="font-medium text-primary underline-offset-2 hover:underline">
              contrat
            </Link>
            , section « États des lieux ».
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Date</th>
                <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
                <th scope="col" className="px-4 py-3 font-medium">Client</th>
                <th scope="col" className="px-4 py-3 font-medium">Au titre de</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-3 tabular">
                    <Link
                      href={`/etats-des-lieux/${row.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {formatDateTime(row.performedAt, timeZone)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{inspectionKindLabels[row.kind]}</td>
                  <td className="px-4 py-3">
                    {row.resourceName}{' '}
                    <span className="text-muted-foreground">
                      ({row.resourceCode} · {resourceTypeLabels[row.resourceType]})
                    </span>
                  </td>
                  <td className="px-4 py-3">{row.clientName}</td>
                  <td className="px-4 py-3">
                    {row.contractReference ? (
                      <span className="tabular">Contrat {row.contractReference}</span>
                    ) : row.bookingTitle ? (
                      <span>Réservation « {row.bookingTitle} »</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${inspectionStageStyles[row.stage]}`}
                    >
                      {inspectionStageLabels[row.stage]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
