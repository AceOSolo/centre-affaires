import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { compareInspections } from '../../../../../modules/etats-des-lieux/comparaison.ts'
import { ComparisonView } from '../../../../../modules/etats-des-lieux/comparison-view.tsx'
import { InspectionValuesView } from '../../../../../modules/etats-des-lieux/inspection-view.tsx'
import { inspectionKindTitles } from '../../../../../modules/etats-des-lieux/labels.ts'
import { findInspection } from '../../../../../modules/etats-des-lieux/queries.ts'
import { PrintButton } from '../../../../../modules/facturation/print-button.tsx'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'

export const metadata = { title: 'État des lieux — vue imprimable' }

/** Rien n'est prérendu : la page dépend de la session, comme le back-office. */
export const dynamic = 'force-dynamic'

/**
 * Vue imprimable d'un état des lieux clos (R06), hors de la coque du
 * back-office : le navigateur l'imprime ou l'enregistre en PDF. Le PDF est
 * une vue, la source reste en base (`CLAUDE.md`). Les photos passent par la
 * route journalisée, comme à l'écran.
 */
export default async function InspectionDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('etats-des-lieux.gerer')
  const { id } = await params
  const [inspection, tenant] = await Promise.all([findInspection(id), currentTenant()])
  if (!inspection || inspection.status !== 'closed') notFound()
  const timeZone = tenant.timezone

  const comparison =
    inspection.kind === 'exit' && inspection.entry
      ? compareInspections(
          { fields: inspection.entry.fields, values: inspection.entry.values },
          { fields: inspection.template.fields, values: inspection.values },
        )
      : null

  return (
    <main className="min-h-screen bg-muted py-8 font-sans text-foreground print:bg-white print:py-0">
      <style>{'@page { size: A4; margin: 15mm; }'}</style>
      <div className="mx-auto mb-6 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 px-4 print:hidden">
        <Link href={`/etats-des-lieux/${inspection.id}`} className="text-sm text-muted-foreground hover:underline">
          ← Retour à l’état des lieux
        </Link>
        <PrintButton label="Imprimer ou enregistrer en PDF" />
      </div>

      <article className="mx-auto flex w-full max-w-[210mm] flex-col gap-6 bg-white px-8 py-10 shadow-sm print:max-w-none print:px-0 print:py-0 print:shadow-none">
        <header className="flex flex-col gap-1 border-b border-border pb-4">
          <p className="text-sm text-muted-foreground">{tenant.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{inspectionKindTitles[inspection.kind]}</h1>
          <p className="text-sm tabular">Établi le {formatDateTime(inspection.performedAt, timeZone)}</p>
        </header>

        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Ressource</dt>
          <dd>
            {inspection.resource.name} ({inspection.resource.code} ·{' '}
            {resourceTypeLabels[inspection.resource.resourceType]})
          </dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>{inspection.client.name}</dd>
          <dt className="text-muted-foreground">Au titre de</dt>
          <dd>
            {[
              inspection.contract ? `Contrat ${inspection.contract.reference}` : null,
              inspection.booking && inspection.booking.kind === 'booking'
                ? `Réservation « ${inspection.booking.title} » du ${formatDateTime(inspection.booking.startsAt, timeZone)}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </dd>
          <dt className="text-muted-foreground">Modèle</dt>
          <dd>
            {inspection.template.name}, version {inspection.template.version}
          </dd>
          {inspection.entry && (
            <>
              <dt className="text-muted-foreground">Entrée</dt>
              <dd className="tabular">du {formatDateTime(inspection.entry.performedAt, timeZone)}</dd>
            </>
          )}
        </dl>

        {comparison && inspection.entry && (
          <section aria-labelledby="comparaison" className="flex flex-col gap-3">
            <h2 id="comparaison" className="text-lg font-semibold tracking-tight">
              Comparaison avec l’entrée
            </h2>
            <ComparisonView
              rows={comparison}
              entryLabel={`Entrée du ${formatDateTime(inspection.entry.performedAt, timeZone)}`}
              exitLabel={`Sortie du ${formatDateTime(inspection.performedAt, timeZone)}`}
            />
          </section>
        )}

        <section aria-labelledby="releve" className="flex flex-col gap-3">
          <h2 id="releve" className="text-lg font-semibold tracking-tight">
            Relevé
          </h2>
          <InspectionValuesView
            fields={inspection.template.fields}
            values={inspection.values}
            observations={inspection.observations}
            photos={inspection.photos}
            photoBase="/etats-des-lieux/photos"
            purgedPhotoCount={inspection.purgedPhotoCount}
            photoRetentionMonths={tenant.inspectionPhotoRetentionMonths}
          />
        </section>

        <section aria-labelledby="signatures" className="grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2 print:grid-cols-2 print:break-inside-avoid">
          <h2 id="signatures" className="sr-only">
            Clôture et validation
          </h2>
          <div>
            <p className="font-medium">Pour le centre</p>
            <p className="tabular">
              Clos le {inspection.closedAt ? formatDateTime(inspection.closedAt, timeZone) : '—'}
              {inspection.closedByName ? ` par ${inspection.closedByName}` : ''}
            </p>
          </div>
          <div>
            <p className="font-medium">Pour le client</p>
            {inspection.signedAt ? (
              <>
                <p className="tabular">
                  Validé en ligne le {formatDateTime(inspection.signedAt, timeZone)}
                  {inspection.signedByName ? ` par ${inspection.signedByName}` : ''}
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {inspection.clientRemarks ? `Réserves : ${inspection.clientRemarks}` : 'Sans réserve.'}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Validation en attente.</p>
            )}
          </div>
        </section>
      </article>
    </main>
  )
}
