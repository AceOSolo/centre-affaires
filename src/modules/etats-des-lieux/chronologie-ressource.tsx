import Link from 'next/link'

import { TriangleAlertIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { occupationPeriodLabel } from '../reservations/affichage.ts'
import { newInspectionHref } from './inspections-section.tsx'
import { inspectionKindLabels, inspectionStageLabels, inspectionStageStyles } from './labels.ts'
import {
  groupByOccupation,
  occupationSituationLabels,
  occupationSituationStyles,
  type TimelineGroup,
} from './occupations.ts'
import { listResourceTimeline, type TimelineRow } from './queries.ts'
import { linkClass, secondaryButton } from './styles.ts'

/** Occupations montrées sur la fiche ; l'historique complet est dans la liste. */
const GROUPS_SHOWN = 20

/** Ce qui est occupé : la réservation et ses dates, ou le contrat. */
function occupationLabel(row: TimelineRow, timeZone: string): string {
  if (row.bookingId && row.bookingKind !== 'contract' && row.bookingTitle && row.bookingStartsAt) {
    const fin = row.bookingEndsAt ? ` → ${formatDateTime(row.bookingEndsAt, timeZone)}` : ''
    return `Réservation « ${row.bookingTitle} », ${formatDateTime(row.bookingStartsAt, timeZone)}${fin}`
  }
  if (row.contractReference) {
    const periode =
      row.bookingKind === 'contract' && row.bookingStartsAt && row.bookingEndsAt
        ? `, occupation ${occupationPeriodLabel({ startsAt: row.bookingStartsAt, endsAt: row.bookingEndsAt }, timeZone)}`
        : ''
    return `Contrat ${row.contractReference}${periode}`
  }
  return 'Occupation'
}

/** Point de départ d'une sortie pour cette occupation : la réservation ou le contrat de l'entrée. */
function exitContext(row: TimelineRow): { reservation: string } | { contrat: string } | { ressource: string } {
  if (row.bookingId && row.bookingKind !== 'contract') return { reservation: row.bookingId }
  if (row.contractId) return { contrat: row.contractId }
  return { ressource: row.resourceId }
}

function StepRow({ row, timeZone }: { row: TimelineRow; timeZone: string }) {
  return (
    <tr>
      <td className="px-4 py-2.5">{inspectionKindLabels[row.kind]}</td>
      <td className="whitespace-nowrap px-4 py-2.5 tabular">
        <Link href={`/etats-des-lieux/${row.id}`} className="font-medium underline-offset-2 hover:underline">
          {formatDateTime(row.performedAt, timeZone)}
        </Link>
      </td>
      <td className="px-4 py-2.5">
        <span
          className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${inspectionStageStyles[row.stage]}`}
        >
          {inspectionStageLabels[row.stage]}
        </span>
      </td>
    </tr>
  )
}

function GroupActions({ group }: { group: TimelineGroup<TimelineRow> }) {
  const { entry, exit } = group
  const actions: { href: string; label: string }[] = []
  if (entry && entry.status === 'draft') {
    actions.push({ href: `/etats-des-lieux/${entry.id}`, label: 'Terminer l’entrée' })
  }
  if (entry && entry.status === 'closed' && !exit) {
    actions.push({ href: newInspectionHref(exitContext(entry), 'exit'), label: 'Faire la sortie' })
  }
  if (exit && exit.status === 'draft') {
    actions.push({ href: `/etats-des-lieux/${exit.id}`, label: 'Terminer la sortie' })
  }
  if (exit && exit.status === 'closed' && entry) {
    actions.push({ href: `/etats-des-lieux/${exit.id}#comparaison-titre`, label: 'Comparer sortie et entrée' })
  }
  if (actions.length === 0) return null
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {actions.map((action) => (
        <Link key={action.href} href={action.href} className={linkClass}>
          {action.label}
        </Link>
      ))}
    </span>
  )
}

/**
 * Chronologie des états des lieux d'une ressource (ADR 063) : entrée → sortie
 * → entrée…, groupées par occupation (réservation ou contrat), la plus récente
 * en tête, chacune avec sa situation et le lien vers la comparaison sortie /
 * entrée. Un vrai tableau : un groupe de lignes par occupation, son en-tête
 * dit l'occupation et le client.
 *
 * La page appelante vérifie le droit `etats-des-lieux.gerer`.
 */
export async function ResourceTimeline({
  resourceId,
  timeZone,
  unavailable,
}: {
  resourceId: string
  timeZone: string
  /** Pourquoi aucun état des lieux ne peut être ouvert ici (ressource archivée). */
  unavailable?: string
}) {
  const rows = await listResourceTimeline(resourceId)
  const groups = groupByOccupation(rows)
  const shown = groups.slice(0, GROUPS_SHOWN)

  return (
    <section aria-labelledby="chronologie-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="chronologie-titre" className="mr-auto text-sm font-semibold tracking-tight">
          États des lieux{' '}
          <span className="font-normal text-muted-foreground">
            ({groups.length} occupation{groups.length > 1 ? 's' : ''})
          </span>
        </h2>
        {!unavailable && (
          <>
            <Link href={newInspectionHref({ ressource: resourceId }, 'entry')} className={secondaryButton}>
              État des lieux d’entrée
            </Link>
            <Link href={newInspectionHref({ ressource: resourceId }, 'exit')} className={secondaryButton}>
              État des lieux de sortie
            </Link>
          </>
        )}
      </div>
      {unavailable && <p className="text-sm text-muted-foreground">{unavailable}</p>}

      {groups.length === 0 ? (
        !unavailable && (
          <p className="text-sm text-muted-foreground">
            Aucun état des lieux. Faites celui d’entrée à la remise des clés, puis celui de sortie à leur
            restitution : la ressource reste occupée de l’une à l’autre, et la sortie se compare à
            l’entrée, champ par champ.
          </p>
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Chronologie des états des lieux, par occupation, la plus récente en tête
            </caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Étape</th>
                <th scope="col" className="px-4 py-3 font-medium">Date</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            {shown.map((group) => {
              const reference = group.entry ?? group.exit!
              const anormal = group.situation === 'non_restituee'
              return (
                <tbody key={group.key} className="border-b border-border last:border-0">
                  <tr className="bg-muted/60">
                    <th scope="rowgroup" colSpan={3} className="px-4 py-2.5 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium text-foreground">{reference.clientName}</span>
                        <span className="text-muted-foreground">{occupationLabel(reference, timeZone)}</span>
                        <span
                          className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${occupationSituationStyles[group.situation]}`}
                        >
                          {anormal && <TriangleAlertIcon size={14} />}
                          {occupationSituationLabels[group.situation]}
                          {anormal && group.entry?.unreturnedSince && (
                            <span className="tabular">
                              {' '}
                              depuis le {formatDateTime(group.entry.unreturnedSince, timeZone)}
                            </span>
                          )}
                        </span>
                        <GroupActions group={group} />
                      </span>
                    </th>
                  </tr>
                  {group.entry && <StepRow row={group.entry} timeZone={timeZone} />}
                  {group.exit && <StepRow row={group.exit} timeZone={timeZone} />}
                </tbody>
              )
            })}
          </table>
        </div>
      )}
      {groups.length > GROUPS_SHOWN && (
        <p className="text-sm text-muted-foreground">
          {GROUPS_SHOWN} occupations les plus récentes sur {groups.length}.{' '}
          <Link href={`/etats-des-lieux?ressource=${resourceId}`} className={linkClass}>
            Tout l’historique de la ressource
          </Link>
        </p>
      )}
    </section>
  )
}
