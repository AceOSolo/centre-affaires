import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CheckIcon } from '../../../../../components/ui/icons.tsx'
import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { compareInspections } from '../../../../../modules/etats-des-lieux/comparaison.ts'
import { ComparisonView } from '../../../../../modules/etats-des-lieux/comparison-view.tsx'
import { InspectionValuesView } from '../../../../../modules/etats-des-lieux/inspection-view.tsx'
import { inspectionKindTitles } from '../../../../../modules/etats-des-lieux/labels.ts'
import { findInspectionForAccounts } from '../../../../../modules/etats-des-lieux/queries.ts'
import { SignForm } from '../../../../../modules/etats-des-lieux/sign-form.tsx'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'

export const metadata = { title: 'État des lieux' }

/**
 * Un état des lieux clos, vu par le client (R06, ADR 039) : le relevé, les
 * photos (journalisées à chaque affichage), la comparaison d'une sortie à son
 * entrée, et la validation.
 */
export default async function ClientInspectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  const { user, accounts } = await requireClientAccount()
  const { id } = await params
  const { fait } = await searchParams
  const [inspection, tenant] = await Promise.all([
    findInspectionForAccounts(id, accounts),
    currentTenant(),
  ])
  if (!inspection) notFound()
  const timeZone = tenant.timezone
  const account = accounts.find((candidate) => candidate.clientId === inspection.client.id)

  const comparison =
    inspection.kind === 'exit' && inspection.entry
      ? compareInspections(
          { fields: inspection.entry.fields, values: inspection.entry.values },
          { fields: inspection.template.fields, values: inspection.values },
        )
      : null

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/compte/etats-des-lieux"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:underline"
        >
          ← Mes états des lieux
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          {inspectionKindTitles[inspection.kind]}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {inspection.resource.name} ({resourceTypeLabels[inspection.resource.resourceType]}) ·{' '}
          {inspection.client.name}
        </p>
      </div>

      {fait === 'valide' && (
        <FlashNotice key={fait}>État des lieux validé : la validation figure désormais au suivi du centre.</FlashNotice>
      )}

      <dl className="grid grid-cols-1 gap-y-1 rounded-lg border border-border bg-white p-4 text-sm sm:grid-cols-[10rem_1fr] sm:gap-y-3 sm:p-5">
        <dt className="text-muted-foreground">Établi le</dt>
        <dd className="mb-2 tabular sm:mb-0">{formatDateTime(inspection.performedAt, timeZone)}</dd>
        <dt className="text-muted-foreground">Au titre de</dt>
        <dd className="mb-2 sm:mb-0">
          {inspection.contract
            ? `Contrat ${inspection.contract.reference}`
            : inspection.booking
              ? `Réservation « ${inspection.booking.title} » du ${formatDateTime(inspection.booking.startsAt, timeZone)}`
              : '—'}
        </dd>
        <dt className="text-muted-foreground">Clos par le centre</dt>
        <dd className="mb-2 tabular sm:mb-0">
          le {inspection.closedAt ? formatDateTime(inspection.closedAt, timeZone) : '—'}
          {inspection.closedByName ? `, par ${inspection.closedByName}` : ''}
        </dd>
        {inspection.entry && (
          <>
            <dt className="text-muted-foreground">Entrée</dt>
            <dd className="mb-2 sm:mb-0">
              <Link
                href={`/compte/etats-des-lieux/${inspection.entry.id}`}
                className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-2 sm:min-h-0"
              >
                État des lieux d’entrée du {formatDateTime(inspection.entry.performedAt, timeZone)}
              </Link>
            </dd>
          </>
        )}
      </dl>

      {inspection.signedAt ? (
        <div className="flex items-start gap-3 rounded-lg border border-primary bg-white p-4 text-sm sm:p-5">
          <CheckIcon size={20} className="mt-0.5 shrink-0 text-primary" />
          <div>
            <p className="font-medium">
              Validé le <span className="tabular">{formatDateTime(inspection.signedAt, timeZone)}</span>
              {inspection.signedByName ? ` par ${inspection.signedByName}` : ''}.
            </p>
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {inspection.clientRemarks ? `Vos réserves : ${inspection.clientRemarks}` : 'Sans réserve.'}
            </p>
          </div>
        </div>
      ) : (
        account && <SignForm inspectionId={inspection.id} memberName={user.name || user.email} />
      )}

      {comparison && inspection.entry && (
        <section aria-labelledby="comparaison-titre" className="flex flex-col gap-3">
          <h2 id="comparaison-titre" className="text-lg font-semibold">
            Comparaison avec l’entrée
          </h2>
          <ComparisonView
            rows={comparison}
            layout="cards"
            entryLabel={`Entrée du ${formatDateTime(inspection.entry.performedAt, timeZone)}`}
            exitLabel={`Sortie du ${formatDateTime(inspection.performedAt, timeZone)}`}
          />
        </section>
      )}

      <section aria-labelledby="releve-titre" className="flex flex-col gap-3">
        <h2 id="releve-titre" className="text-lg font-semibold">
          Relevé
        </h2>
        <InspectionValuesView
          fields={inspection.template.fields}
          values={inspection.values}
          observations={inspection.observations}
          photos={inspection.photos}
          photoBase="/compte/etats-des-lieux/photos"
          purgedPhotoCount={inspection.purgedPhotoCount}
          photoRetentionMonths={tenant.inspectionPhotoRetentionMonths}
        />
        <p className="text-xs text-muted-foreground">
          Les photos sont conservées {tenant.inspectionPhotoRetentionMonths} mois après l’état des
          lieux de sortie, puis effacées. Chaque consultation est enregistrée.
        </p>
      </section>
    </div>
  )
}
