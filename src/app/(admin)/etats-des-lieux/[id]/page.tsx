import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ConfirmDialog } from '../../../../components/ui/confirm-dialog.tsx'
import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime, toWallClock } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { withdrawInspectionAction } from '../../../../modules/etats-des-lieux/actions.ts'
import { valueInputName, valueToInput } from '../../../../modules/etats-des-lieux/champs.ts'
import { compareInspections } from '../../../../modules/etats-des-lieux/comparaison.ts'
import { ComparisonView } from '../../../../modules/etats-des-lieux/comparison-view.tsx'
import { InspectionForm } from '../../../../modules/etats-des-lieux/inspection-form.tsx'
import { newInspectionHref } from '../../../../modules/etats-des-lieux/inspections-section.tsx'
import { InspectionValuesView } from '../../../../modules/etats-des-lieux/inspection-view.tsx'
import {
  inspectionKindTitles,
  inspectionStageLabels,
  inspectionStageStyles,
} from '../../../../modules/etats-des-lieux/labels.ts'
import { findInspection } from '../../../../modules/etats-des-lieux/queries.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'État des lieux' }

const PHOTO_BASE = '/etats-des-lieux/photos'

const notices: Record<string, string> = {
  cree: 'Brouillon ouvert. Saisissez les champs et ajoutez les photos ; rien n’est visible du client avant la clôture.',
  enregistre: 'Brouillon enregistré.',
  clos: 'État des lieux clos : il est figé, et le client peut le consulter et le valider dans son espace.',
}

/**
 * Fiche d'un état des lieux (R06, ADR 039) : la saisie tant qu'il est un
 * brouillon, la lecture une fois clos, et pour une sortie la comparaison avec
 * son entrée.
 */
export default async function InspectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  await requirePermission('etats-des-lieux.gerer')
  const { id } = await params
  const { fait } = await searchParams
  const [inspection, tenant] = await Promise.all([findInspection(id), currentTenant()])
  if (!inspection) notFound()
  const timeZone = tenant.timezone
  const fields = inspection.template.fields
  const isDraft = inspection.stage === 'draft'

  // Point de départ de la sortie : la même occupation que l'entrée.
  const exitContext = inspection.booking
    ? { reservation: inspection.booking.id }
    : inspection.contract
      ? { contrat: inspection.contract.id }
      : { ressource: inspection.resource.id }

  const comparison =
    inspection.kind === 'exit' && inspection.entry
      ? compareInspections(
          { fields: inspection.entry.fields, values: inspection.entry.values },
          { fields, values: inspection.values },
        )
      : null

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/etats-des-lieux" className="text-sm text-muted-foreground hover:underline">
          ← États des lieux
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{inspectionKindTitles[inspection.kind]}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${inspectionStageStyles[inspection.stage]}`}
          >
            {inspectionStageLabels[inspection.stage]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {inspection.resource.name} · {inspection.client.name} ·{' '}
          <span className="tabular">{formatDateTime(inspection.performedAt, timeZone)}</span>
        </p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Ressource</dt>
        <dd>
          <Link href={`/ressources/${inspection.resource.id}`} className="underline-offset-2 hover:underline">
            {inspection.resource.name}
          </Link>{' '}
          <span className="text-muted-foreground">
            ({inspection.resource.code} · {resourceTypeLabels[inspection.resource.resourceType]})
          </span>
        </dd>

        <dt className="text-muted-foreground">Client</dt>
        <dd>
          <Link href={`/clients/${inspection.client.id}`} className="underline-offset-2 hover:underline">
            {inspection.client.name}
          </Link>
        </dd>

        <dt className="text-muted-foreground">Au titre de</dt>
        <dd className="flex flex-col gap-1">
          {inspection.contract && (
            <Link href={`/contrats/${inspection.contract.id}`} className="tabular underline-offset-2 hover:underline">
              Contrat {inspection.contract.reference}
            </Link>
          )}
          {inspection.booking && inspection.booking.kind === 'booking' && (
            <Link href={`/reservations/${inspection.booking.id}`} className="underline-offset-2 hover:underline">
              Réservation « {inspection.booking.title} » du {formatDateTime(inspection.booking.startsAt, timeZone)}
            </Link>
          )}
        </dd>

        <dt className="text-muted-foreground">Modèle</dt>
        <dd>
          {inspection.template.name}{' '}
          <span className="text-muted-foreground">(version {inspection.template.version})</span>
        </dd>

        <dt className="text-muted-foreground">Ouvert par</dt>
        <dd>
          {inspection.createdByName ?? '—'}{' '}
          <span className="text-muted-foreground tabular">le {formatDateTime(inspection.createdAt, timeZone)}</span>
        </dd>

        {inspection.closedAt && (
          <>
            <dt className="text-muted-foreground">Clos</dt>
            <dd>
              le <span className="tabular">{formatDateTime(inspection.closedAt, timeZone)}</span>
              {inspection.closedByName ? ` par ${inspection.closedByName}` : ''}
            </dd>
            <dt className="text-muted-foreground">Validation du client</dt>
            <dd>
              {inspection.signedAt ? (
                <>
                  Validé le <span className="tabular">{formatDateTime(inspection.signedAt, timeZone)}</span>
                  {inspection.signedByName ? ` par ${inspection.signedByName}` : ''}
                  {inspection.clientRemarks ? (
                    <p className="mt-1 whitespace-pre-line rounded-md bg-muted px-3 py-2">
                      <span className="font-medium">Réserves du client : </span>
                      {inspection.clientRemarks}
                    </p>
                  ) : (
                    <span className="text-muted-foreground"> — sans réserve</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">
                  En attente : le client le valide depuis son espace.
                </span>
              )}
            </dd>
          </>
        )}

        {inspection.kind === 'exit' && (
          <>
            <dt className="text-muted-foreground">Entrée</dt>
            <dd>
              {inspection.entry ? (
                <Link href={`/etats-des-lieux/${inspection.entry.id}`} className="underline-offset-2 hover:underline">
                  État des lieux d’entrée du {formatDateTime(inspection.entry.performedAt, timeZone)}
                </Link>
              ) : (
                <span className="text-muted-foreground">
                  Aucune : l’entrée n’a pas été faite dans l’application, la sortie ne se compare à rien.
                </span>
              )}
            </dd>
          </>
        )}
        {inspection.kind === 'entry' && inspection.stage !== 'draft' && inspection.stage !== 'withdrawn' && (
          <>
            <dt className="text-muted-foreground">Sortie</dt>
            <dd>
              {inspection.exit ? (
                <Link href={`/etats-des-lieux/${inspection.exit.id}`} className="underline-offset-2 hover:underline">
                  État des lieux de sortie ({inspectionStageLabels[inspection.exit.stage].toLowerCase()})
                </Link>
              ) : (
                <Link
                  href={newInspectionHref(exitContext, 'exit')}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Faire l’état des lieux de sortie
                </Link>
              )}
            </dd>
          </>
        )}
      </dl>

      {inspection.stage === 'withdrawn' ? (
        <p className="rounded-lg border border-border bg-muted px-5 py-4 text-sm">
          Brouillon retiré : il avait été ouvert par erreur. Il reste consultable ici, mais ne se
          modifie plus.
        </p>
      ) : isDraft ? (
        <>
          <InspectionForm
            inspectionId={inspection.id}
            fields={fields}
            initialValues={Object.fromEntries(
              fields.map((field) => [valueInputName(field.id), valueToInput(field, inspection.values[field.id])]),
            )}
            performedAt={toWallClock(inspection.performedAt, timeZone)}
            observations={inspection.observations ?? ''}
            photos={inspection.photos}
            photoBase={PHOTO_BASE}
          />
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4 text-sm">
            <p className="text-muted-foreground">
              Ouvert par erreur (mauvaise ressource, mauvais client) ? Retirez le brouillon : il sort
              des listes, et ses photos sont effacées.
            </p>
            <div>
              <ConfirmDialog
                triggerLabel="Retirer le brouillon"
                triggerClassName="rounded-md border border-destructive/30 bg-white px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title="Retirer ce brouillon d’état des lieux ?"
                confirmLabel="Retirer le brouillon"
                pendingLabel="Retrait…"
                action={withdrawInspectionAction}
                fields={{ id: inspection.id }}
              >
                <p>
                  Le brouillon sort de la liste des états des lieux et ses photos sont effacées. Il ne
                  pourra plus être repris : un nouvel état des lieux s’ouvre depuis la fiche.
                </p>
              </ConfirmDialog>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/etats-des-lieux/${inspection.id}/document`}
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted"
            >
              Vue imprimable
            </Link>
          </div>

          {comparison && inspection.entry && (
            <section aria-labelledby="comparaison-titre" className="flex flex-col gap-3">
              <h2 id="comparaison-titre" className="text-lg font-semibold tracking-tight">
                Comparaison avec l’entrée
              </h2>
              <ComparisonView
                rows={comparison}
                entryLabel={`Entrée du ${formatDateTime(inspection.entry.performedAt, timeZone)}`}
                exitLabel={`Sortie du ${formatDateTime(inspection.performedAt, timeZone)}`}
              />
            </section>
          )}

          <section aria-labelledby="releve-titre" className="flex flex-col gap-3">
            <h2 id="releve-titre" className="text-lg font-semibold tracking-tight">
              Relevé
            </h2>
            <InspectionValuesView
              fields={fields}
              values={inspection.values}
              observations={inspection.observations}
              photos={inspection.photos}
              photoBase={PHOTO_BASE}
              purgedPhotoCount={inspection.purgedPhotoCount}
              photoRetentionMonths={tenant.inspectionPhotoRetentionMonths}
            />
          </section>
        </>
      )}
    </div>
  )
}
