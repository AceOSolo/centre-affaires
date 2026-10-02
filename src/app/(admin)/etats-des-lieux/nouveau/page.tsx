import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime, formatTime, toIsoDate, toWallClock } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import {
  NewInspectionForm,
  type CandidateOption,
} from '../../../../modules/etats-des-lieux/new-inspection-form.tsx'
import {
  listOccupationCandidates,
  listOpenEntries,
  type CandidateContext,
  type OccupationCandidate,
} from '../../../../modules/etats-des-lieux/queries.ts'
import { occupationPeriodLabel } from '../../../../modules/reservations/affichage.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Nouvel état des lieux' }

function describe(candidate: OccupationCandidate, timeZone: string): { label: string; detail: string } {
  const resource = `${candidate.resource.name} (${candidate.resource.code} · ${resourceTypeLabels[candidate.resource.resourceType]})`
  if (!candidate.bookingId) {
    return {
      label: `Contrat ${candidate.contractReference ?? ''} — ${resource}`,
      detail: `${candidate.client.name} · contrat en brouillon, pas encore d’occupation`,
    }
  }
  if (candidate.bookingKind === 'contract' && candidate.startsAt && candidate.endsAt) {
    return {
      label: `Contrat ${candidate.contractReference ?? ''} — ${resource}`,
      detail: `${candidate.client.name} · occupation ${occupationPeriodLabel(
        { startsAt: candidate.startsAt, endsAt: candidate.endsAt },
        timeZone,
      )}`,
    }
  }
  return {
    label: `Réservation « ${candidate.bookingTitle ?? ''} » — ${resource}`,
    detail: `${candidate.client.name} · ${
      candidate.startsAt ? formatDateTime(candidate.startsAt, timeZone) : ''
    }${candidate.endsAt ? ` – ${formatTime(candidate.endsAt, timeZone)}` : ''}${
      candidate.contractReference ? ` · contrat ${candidate.contractReference}` : ''
    }`,
  }
}

/**
 * Ouverture d'un état des lieux d'entrée ou de sortie (R06), depuis une
 * réservation (`?reservation=`), un contrat (`?contrat=`) ou une ressource
 * (`?ressource=`).
 */
export default async function NewInspectionPage({
  searchParams,
}: {
  searchParams: Promise<{ reservation?: string; contrat?: string; ressource?: string; nature?: string }>
}) {
  await requirePermission('etats-des-lieux.gerer')
  const { reservation, contrat, ressource, nature } = await searchParams

  let context: CandidateContext
  let backHref: string
  let backLabel: string
  if (reservation) {
    context = { kind: 'booking', id: reservation }
    backHref = `/reservations/${reservation}`
    backLabel = 'la réservation'
  } else if (contrat) {
    context = { kind: 'contract', id: contrat }
    backHref = `/contrats/${contrat}`
    backLabel = 'le contrat'
  } else if (ressource) {
    context = { kind: 'resource', id: ressource }
    backHref = `/ressources/${ressource}`
    backLabel = 'la ressource'
  } else {
    notFound()
  }
  if (!isUuid(context.id)) notFound()

  const [candidates, timeZone] = await Promise.all([
    listOccupationCandidates(context),
    currentTimeZone(),
  ])

  // Les entrées à clore, une fois par couple client et ressource.
  const entriesByPair = new Map<string, { id: string; label: string }[]>()
  await Promise.all(
    candidates.map(async (candidate) => {
      const pair = `${candidate.client.id}:${candidate.resource.id}`
      if (entriesByPair.has(pair)) return
      entriesByPair.set(pair, [])
      const entries = await listOpenEntries(candidate.client.id, candidate.resource.id)
      entriesByPair.set(
        pair,
        entries.map((entry) => ({
          id: entry.id,
          label: `Entrée du ${formatDateTime(entry.performedAt, timeZone)}`,
        })),
      )
    }),
  )
  const options: CandidateOption[] = candidates.map((candidate) => ({
    key: candidate.key,
    ...describe(candidate, timeZone),
    openEntries: entriesByPair.get(`${candidate.client.id}:${candidate.resource.id}`) ?? [],
  }))

  const defaultKind = nature === 'sortie' ? 'exit' : 'entry'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={backHref} className="text-sm text-muted-foreground hover:underline">
          ← Revenir à {backLabel}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvel état des lieux</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Le formulaire suit le modèle du type de la ressource, dans sa version du jour. La saisie
          reste un brouillon, invisible du client, jusqu’à sa clôture.
        </p>
      </div>

      {options.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-sm">
          <p>
            Aucune occupation à laquelle rattacher un état des lieux : un état des lieux concerne un
            client, au titre d’une réservation ou d’un contrat.
          </p>
          <p className="mt-2 text-muted-foreground">
            {context.kind === 'booking'
              ? 'Rattachez d’abord un client à la réservation, ou vérifiez qu’elle n’est pas annulée.'
              : context.kind === 'contract'
                ? 'Le contrat n’a ni occupation ni ressource prévue.'
                : `Aucune réservation d’un client sur cette ressource autour d’aujourd’hui (${toIsoDate(
                    new Date(),
                    timeZone,
                  ).split('-').reverse().join('/')}), ni contrat en brouillon.`}
          </p>
          <Link href={backHref} className="mt-4 inline-block font-medium text-primary underline-offset-2 hover:underline">
            Revenir à {backLabel}
          </Link>
        </div>
      ) : (
        <NewInspectionForm
          contextKind={context.kind}
          contextId={context.id}
          candidates={options}
          defaultKind={defaultKind}
          defaultPerformedAt={toWallClock(new Date(), timeZone)}
          cancelHref={backHref}
        />
      )}
    </div>
  )
}
