import Link from 'next/link'

import { formatDateTime } from '../../lib/dates.ts'
import {
  inspectionKindLabels,
  inspectionStageLabels,
  inspectionStageStyles,
} from './labels.ts'
import { canOpenEntry, canOpenExit, progressHint } from './occupations.ts'
import { listInspections, listOccupationCandidates, type CandidateContext, type InspectionFilter } from './queries.ts'
import { secondaryButton } from './styles.ts'

/** Lien vers l'ouverture d'un état des lieux depuis une fiche. */
export function newInspectionHref(
  context: { reservation: string } | { contrat: string } | { ressource: string },
  kind: 'entry' | 'exit',
): string {
  const params = new URLSearchParams({ ...context, nature: kind === 'entry' ? 'entree' : 'sortie' })
  return `/etats-des-lieux/nouveau?${params.toString()}`
}

/**
 * États des lieux d'une ressource, d'une réservation ou d'un contrat, sur sa
 * fiche (R06), avec de quoi en ouvrir un. La page appelante vérifie le droit
 * `etats-des-lieux.gerer` avant de rendre cette section.
 */
export async function InspectionsSection({
  filter,
  context,
  timeZone,
  showResource = false,
  unavailable,
}: {
  filter: Pick<InspectionFilter, 'resourceId' | 'bookingId' | 'contractId'>
  context: { reservation: string } | { contrat: string } | { ressource: string }
  timeZone: string
  /** Afficher la ressource (fiche contrat, où elle peut changer par avenant). */
  showResource?: boolean
  /** Pourquoi aucun état des lieux ne peut être ouvert ici, le cas échéant. */
  unavailable?: string
}) {
  const candidateContext: CandidateContext =
    'reservation' in context
      ? { kind: 'booking', id: context.reservation }
      : 'contrat' in context
        ? { kind: 'contract', id: context.contrat }
        : { kind: 'resource', id: context.ressource }
  const [rows, candidates] = await Promise.all([
    listInspections(filter, 50),
    unavailable ? [] : listOccupationCandidates(candidateContext),
  ])
  // Une entrée par occupation (ADR 063) : le bouton « entrée » disparaît dès
  // que l'occupation a la sienne, et seule la sortie reste proposée. Sans
  // occupation à proposer, les deux restent : la page suivante dit pourquoi.
  const showEntry = candidates.length === 0 || candidates.some((candidate) => canOpenEntry(candidate.progress))
  const showExit = candidates.length === 0 || candidates.some((candidate) => canOpenExit(candidate.progress))
  const hint = candidates.length === 1 ? progressHint(candidates[0].progress) : null

  return (
    <section aria-labelledby="etats-des-lieux-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="etats-des-lieux-titre" className="mr-auto text-sm font-semibold tracking-tight">
          États des lieux <span className="font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        {!unavailable && showEntry && (
          <Link href={newInspectionHref(context, 'entry')} className={secondaryButton}>
            État des lieux d’entrée
          </Link>
        )}
        {!unavailable && showExit && (
          <Link href={newInspectionHref(context, 'exit')} className={secondaryButton}>
            État des lieux de sortie
          </Link>
        )}
      </div>
      {unavailable && <p className="text-sm text-muted-foreground">{unavailable}</p>}
      {!unavailable && hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {rows.length === 0 ? (
        !unavailable && (
          <p className="text-sm text-muted-foreground">
            Aucun état des lieux. Faites celui d’entrée à la remise des clés, puis celui de sortie à
            leur restitution : la sortie se compare à l’entrée, champ par champ.
          </p>
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Date</th>
                <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                {showResource && <th scope="col" className="px-4 py-3 font-medium">Ressource</th>}
                <th scope="col" className="px-4 py-3 font-medium">Client</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-3 tabular">
                    <Link href={`/etats-des-lieux/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                      {formatDateTime(row.performedAt, timeZone)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{inspectionKindLabels[row.kind]}</td>
                  {showResource && (
                    <td className="px-4 py-3">
                      {row.resourceName} <span className="text-muted-foreground">({row.resourceCode})</span>
                    </td>
                  )}
                  <td className="px-4 py-3">{row.clientName}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${inspectionStageStyles[row.stage]}`}>
                      {inspectionStageLabels[row.stage]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
