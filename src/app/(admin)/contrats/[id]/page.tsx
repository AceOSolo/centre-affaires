import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { formatDateTime, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import {
  ActivateForm,
  ArchiveButton,
  ResourceForm,
  RestoreForm,
} from '../../../../modules/contrats/contract-actions.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { listAmendments } from '../../../../modules/contrats/avenants.ts'
import { EstablishDocumentButton } from '../../../../modules/contrats/document-actions.tsx'
import { listContractDocuments } from '../../../../modules/contrats/documents.ts'
import {
  addDays,
  commitmentSchedule,
  earliestEndOn,
} from '../../../../modules/contrats/echeancier.ts'
import { EcheancierTable } from '../../../../modules/contrats/echeancier-table.tsx'
import {
  amendmentChangesLabel,
  amendmentStateLabel,
  amendmentStateStyle,
  billingPeriodLabels,
  billingPeriodSuffixes,
  contractStatusLabels,
  contractStatusStyles,
  contractTypeLabels,
} from '../../../../modules/contrats/labels.ts'
import { formatBpAsPercent } from '../../../../modules/contrats/lignes.ts'
import { ContractLinesTable } from '../../../../modules/contrats/lines-table.tsx'
import {
  canChangeContractResource,
  contractOccupiesResource,
  formatCalendarDate,
  formatContractDays,
  lastContractDay,
  occupationDays,
} from '../../../../modules/contrats/occupation.ts'
import { findContract, findContractOccupation } from '../../../../modules/contrats/queries.ts'
import { listContractRenewals } from '../../../../modules/contrats/reconduction-queries.ts'
import { listContractSubscriptions } from '../../../../modules/contrats/souscriptions.ts'
import { TerminateForm } from '../../../../modules/contrats/terminate-form.tsx'
import {
  findContractTerms,
  listContractOccupations,
  scheduleVersions,
  segmentOn,
} from '../../../../modules/contrats/versions.ts'
import { prorataRuleLabels } from '../../../../modules/facturation/parametres-libelles.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Contrat' }

/** Confirmations affichées après une action, selon `?fait=`. */
const notices: Record<string, string> = {
  modifie: 'Brouillon enregistré.',
  lignes: 'Lignes enregistrées : le montant du contrat en découle.',
  active:
    'Contrat activé : il est facturable, occupe sa ressource, et son document est archivé avec son empreinte.',
  ressource: 'Ressource changée : l’occupation a suivi.',
  resilie: 'Contrat résilié : la ressource est libre au lendemain du dernier jour.',
  archive: 'Contrat archivé. Il n’apparaît plus dans la liste, sauf filtre « Archivés ».',
  restaure: 'Contrat désarchivé.',
  document: 'Document du contrat établi et archivé, avec son empreinte.',
}

export default async function ContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  const { member } = await requirePermission('contrats.consulter')
  const { id } = await params
  const { fait } = await searchParams
  if (!isUuid(id)) notFound()
  const [contract, occupation, tenant, terms, amendments, documents, subscriptions, occupations, renewals] =
    await Promise.all([
      findContract(id),
      findContractOccupation(id),
      currentTenant(),
      findContractTerms(id),
      listAmendments(id),
      listContractDocuments(id),
      listContractSubscriptions(id),
      listContractOccupations(id),
      listContractRenewals(id),
    ])
  if (!contract) notFound()
  const timeZone = tenant.timezone

  const archived = contract.deletedAt !== null
  // Le jour du centre, pas celui du serveur (décision 4).
  const today = todayIsoDate(timeZone)
  // Avant le début, la ressource change ici (ADR 018) ; après, par avenant
  // (ADR 025), pour garder la période écoulée sur l'ancienne ressource.
  const canManageOccupation = !archived && can(member.role, 'contrats.activer')
  const canChangeResource = canManageOccupation && canChangeContractResource(contract, today)
  const resources = canChangeResource ? await listResources() : []
  const canAmend = !archived && contract.status === 'active' && can(member.role, 'contrats.avenants')

  // Douze mois d'horizon, et au moins jusqu'à la fin de l'engagement : assez
  // pour le lire sans dérouler une durée indéterminée jusqu'à la fin des temps.
  const twelveMonths = addDays(today, 365)
  const horizon =
    contract.commitmentEndsOn && contract.commitmentEndsOn > twelveMonths
      ? contract.commitmentEndsOn
      : twelveMonths
  const versions = scheduleVersions(terms.versions)
  // Ce que l'engagement garantit, aux versions de prix et à la règle du centre (R10).
  const engagement = commitmentSchedule(contract, versions, tenant.prorataRule)
  const money = (cents: number) => formatCents(cents, contract.currency)
  // La version et la ressource en vigueur aujourd'hui (le premier jour pour un
  // contrat à venir) : `amount_cents` et `resource_id` gardent la version
  // initiale (ADR 025).
  const currentVersion = segmentOn(terms.versions, today)
  const currentSegment = segmentOn(terms.segments, today)
  const currentResource = currentSegment ? currentSegment.resource : contract.resource
  const resourceLabel = currentResource
    ? `${currentResource.name} (${currentResource.code})`
    : null
  const hasInitialDocument = documents.some((document) => document.amendmentId === null)
  // Le résumé d'occupation décrit le dernier segment : sa ressource, pas
  // forcément celle d'aujourd'hui (un avenant peut prendre effet plus tard).
  const lastOccupied = occupations.find(({ booking }) => booking.id === occupation?.id)?.resource
  const occupationLabel = lastOccupied ? `${lastOccupied.name} (${lastOccupied.code})` : null
  // À la création, la référence vient souvent de la numérotation automatique
  // (ADR 021) : la confirmation la donne.
  const notice =
    fait === 'cree'
      ? `Contrat créé en brouillon, sous la référence ${contract.reference}.`
      : fait
        ? notices[fait]
        : undefined

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={archived ? '/contrats?archives=1' : '/contrats'}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Contrats
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight tabular">{contract.reference}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${contractStatusStyles[contract.status]}`}
          >
            {contractStatusLabels[contract.status]}
          </span>
          {archived && (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              Archivé
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {contractTypeLabels[contract.contractType]} —{' '}
          <Link href={`/clients/${contract.clientId}`} className="underline-offset-2 hover:underline">
            {contract.client.name}
          </Link>
        </p>
      </div>

      {notice && <FlashNotice key={fait}>{notice}</FlashNotice>}

      {archived && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted px-5 py-4 text-sm">
          <p>
            Contrat archivé — il ne figure plus dans les listes et n’occupe plus sa ressource. Il
            reste consultable, avec son numéro (décision 6).
          </p>
          {can(member.role, 'contrats.archiver') && <RestoreForm contractId={contract.id} />}
        </div>
      )}

      {!archived &&
        contract.status === 'draft' &&
        (can(member.role, 'contrats.activer') || can(member.role, 'contrats.creer')) && (
          <div className="flex flex-col gap-3">
            {can(member.role, 'contrats.activer') && (
              <ActivateForm contractId={contract.id} resourceLabel={resourceLabel} />
            )}
            {can(member.role, 'contrats.creer') && (
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
                <Link
                  href={`/contrats/${contract.id}/modifier`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Modifier le brouillon
                </Link>
                <Link
                  href={`/contrats/${contract.id}/lignes`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Modifier les lignes
                </Link>
                <Link
                  href={`/contrats/${contract.id}/document`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Aperçu du document
                </Link>
              </div>
            )}
          </div>
        )}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Prix en vigueur</dt>
        <dd className="tabular-nums">
          {money(currentVersion?.amountCents ?? contract.amountCents)}{' '}
          <span className="text-muted-foreground">
            HT {billingPeriodSuffixes[contract.billingPeriod]} — facturation{' '}
            {billingPeriodLabels[contract.billingPeriod].toLowerCase()}
            {currentVersion?.amendmentNumber
              ? `, depuis l’avenant n° ${currentVersion.amendmentNumber}`
              : ''}
          </span>
          {currentVersion?.amendmentNumber && (
            <span className="block text-xs text-muted-foreground">
              Prix initial : {money(contract.amountCents)}
            </span>
          )}
        </dd>

        {(currentVersion?.lines.length ?? 0) === 0 && (
          <>
            <dt className="text-muted-foreground">TVA</dt>
            <dd className="tabular">{formatBpAsPercent(contract.vatRateBp)} %</dd>
          </>
        )}

        <dt className="text-muted-foreground">Début</dt>
        <dd className="tabular">{formatCalendarDate(contract.startsOn)}</dd>

        <dt className="text-muted-foreground">Terme</dt>
        <dd className="tabular">
          {contract.endsOn ? formatCalendarDate(contract.endsOn) : 'Durée indéterminée'}
          {contract.tacitRenewal && contract.renewalMonths && (
            <span className="text-muted-foreground">
              {' '}
              — reconduction tacite par périodes de {contract.renewalMonths} mois
            </span>
          )}
          {renewals.map((renewal) => (
            <span key={renewal.id} className="block text-xs text-muted-foreground">
              Reconduit tacitement le {formatCalendarDate(renewal.renewedOn)} : terme porté du{' '}
              {formatCalendarDate(renewal.previousEndsOn)} au {formatCalendarDate(renewal.newEndsOn)}
            </span>
          ))}
        </dd>

        <dt className="text-muted-foreground">Engagement</dt>
        <dd className="tabular">
          {contract.commitmentMonths && contract.commitmentEndsOn
            ? `${contract.commitmentMonths} mois, jusqu’au ${formatCalendarDate(contract.commitmentEndsOn)} inclus`
            : 'Sans engagement'}
        </dd>

        <dt className="text-muted-foreground">Préavis</dt>
        <dd>{contract.noticeDays} jours</dd>

        <dt className="text-muted-foreground">Ressource</dt>
        <dd>
          {currentResource
            ? `${currentResource.name} (${currentResource.code} · ${resourceTypeLabels[currentResource.resourceType]})`
            : '—'}
          {currentSegment?.amendmentNumber && (
            <span className="text-muted-foreground">
              {' '}
              — depuis l’avenant n° {currentSegment.amendmentNumber}
            </span>
          )}
        </dd>

        {terms.offerName && (
          <>
            <dt className="text-muted-foreground">Offre d’origine</dt>
            <dd>
              {terms.offerName}{' '}
              <span className="text-muted-foreground">
                — lignes copiées à la création, sans lien avec l’offre depuis
              </span>
            </dd>
          </>
        )}

        <dt className="text-muted-foreground">Grille</dt>
        <dd>
          {contract.ratePlan ? (
            <Link
              href={`/tarifs/${contract.ratePlan.id}`}
              className="underline-offset-2 hover:underline"
            >
              {contract.ratePlan.name}
            </Link>
          ) : (
            'Grille par défaut du centre'
          )}
        </dd>

        {contract.status === 'terminated' && (
          <>
            <dt className="text-muted-foreground">Résilié au</dt>
            <dd className="tabular">
              {contract.terminatedOn ? formatCalendarDate(contract.terminatedOn) : '—'}
            </dd>
            <dt className="text-muted-foreground">Motif</dt>
            <dd>{contract.terminationReason ?? '—'}</dd>
          </>
        )}

        {contract.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{contract.notes}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="lignes-title" className="flex flex-col gap-3">
        <h2 id="lignes-title" className="text-sm font-semibold tracking-tight">
          Lignes du contrat
          {currentVersion?.amendmentNumber
            ? ` — version de l’avenant n° ${currentVersion.amendmentNumber}`
            : ''}
        </h2>
        {currentVersion && currentVersion.lines.length > 0 ? (
          <ContractLinesTable
            lines={currentVersion.lines}
            currency={contract.currency}
            periodSuffix={billingPeriodSuffixes[contract.billingPeriod]}
            caption="Lignes de la version en vigueur"
          />
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Pas de détail en lignes : le contrat se facture de son montant, à la TVA du contrat.
            {!archived && contract.status === 'draft' && can(member.role, 'contrats.creer') && (
              <>
                {' '}
                <Link
                  href={`/contrats/${contract.id}/lignes`}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  Détailler le prix en lignes
                </Link>
              </>
            )}
          </p>
        )}
        {subscriptions.length > 0 && (
          <div className="rounded-lg border border-border bg-white px-5 py-4 text-sm">
            <p className="font-medium">Services souscrits avec le contrat</p>
            <ul className="mt-2 flex flex-col gap-1">
              {subscriptions.map(({ subscription, serviceName }) => (
                <li key={subscription.id}>
                  {serviceName}
                  {subscription.includedQuantity !== null
                    ? ` — ${subscription.includedQuantity} inclus par mois, puis ${money(subscription.unitPriceCents)} HT l’unité`
                    : ` — ${money(subscription.netAmountCents ?? 0)} HT`}
                  <span className="text-muted-foreground">
                    {', '}
                    {formatContractDays({ firstDay: subscription.startsOn, lastDay: subscription.endsOn })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {contract.status !== 'draft' && (
        <section id="avenants" aria-labelledby="avenants-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="avenants-title" className="text-sm font-semibold tracking-tight">
              Avenants
            </h2>
            {canAmend && (
              <Link
                href={`/contrats/${contract.id}/avenants/nouveau`}
                className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                Établir un avenant
              </Link>
            )}
          </div>
          {amendments.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
              Aucun avenant. Un changement de prix ou de ressource en cours de contrat passe par un
              avenant, à une date d’effet
              {canAmend ? ' : « Établir un avenant ».' : ', établi par l’exploitant.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Historique des avenants du contrat</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">N°</th>
                    <th scope="col" className="px-4 py-3 font-medium">Date d’effet</th>
                    <th scope="col" className="px-4 py-3 font-medium">Objet</th>
                    <th scope="col" className="px-4 py-3 font-medium">Ce qu’il change</th>
                    <th scope="col" className="px-4 py-3 font-medium">État</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {amendments.map((amendment) => (
                    <tr key={amendment.id}>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/contrats/${contract.id}/avenants/${amendment.id}`}
                          className="tabular text-primary underline-offset-2 hover:underline"
                        >
                          Avenant n° {amendment.number}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular">
                        {formatCalendarDate(amendment.effectiveOn)}
                      </td>
                      <td className="px-4 py-2.5">{amendment.reason ?? '—'}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {amendmentChangesLabel(
                          { ...amendment, lineCount: amendment.lines.length },
                          money,
                          contract.billingPeriod,
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${amendmentStateStyle(amendment)}`}
                        >
                          {amendmentStateLabel(amendment)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="occupation-title" className="flex flex-col gap-3">
        <h2 id="occupation-title" className="text-sm font-semibold tracking-tight">
          Occupation de la ressource
        </h2>
        <OccupationSummary
          contract={contract}
          occupation={occupation}
          resourceLabel={occupationLabel ?? resourceLabel}
          timeZone={timeZone}
          canChangeResource={canChangeResource}
        />
        {occupations.length > 1 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Occupations successives du contrat, par segment</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
                  <th scope="col" className="px-4 py-3 font-medium">Période</th>
                  <th scope="col" className="px-4 py-3 font-medium">Au titre de</th>
                  <th scope="col" className="px-4 py-3 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {occupations.map(({ booking, resource }) => (
                  <tr key={booking.id}>
                    <td className="px-4 py-2.5">
                      {resource ? `${resource.name} (${resource.code})` : '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular">
                      {formatContractDays(occupationDays(booking, timeZone))}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{booking.title}</td>
                    <td className="px-4 py-2.5">
                      {booking.status === 'cancelled' ? (
                        <span className="text-muted-foreground">
                          Levée — {booking.cancellationReason ?? 'sans motif'}
                        </span>
                      ) : (
                        <Link
                          href={`/reservations/${booking.id}`}
                          className="text-primary underline underline-offset-2"
                        >
                          Occupée
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canChangeResource ? (
          <ResourceForm
            contractId={contract.id}
            resourceId={contract.resourceId}
            resources={resources}
          />
        ) : (
          contract.status === 'active' &&
          !archived && (
            <p className="text-xs text-muted-foreground">
              Ce contrat a commencé le{' '}
              <span className="tabular">{formatCalendarDate(contract.startsOn)}</span> : sa
              ressource change par avenant, à une date d’effet — l’ancienne reste occupée jusqu’à
              la veille.{' '}
              {canAmend && (
                <Link
                  href={`/contrats/${contract.id}/avenants/nouveau?ressource=1`}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  Changer de ressource par avenant
                </Link>
              )}
            </p>
          )
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Échéancier prévisionnel</h2>
        <p className="text-xs text-muted-foreground">
          Périodes civiles, coupées aux dates d’effet des avenants ; période partielle selon la
          règle du centre : {prorataRuleLabels[tenant.prorataRule].label.toLowerCase()}. Chaque
          morceau est facturé aux lignes de sa version, remises comprises. Calculé à la lecture,
          jamais figé en base.
        </p>
        {engagement && (
          <p className="text-sm">
            <strong className="font-medium">Engagement jusqu’au </strong>
            <span className="tabular">{formatCalendarDate(engagement.endsOn)}</span> : minimum dû
            sur la durée d’engagement,{' '}
            <span className="tabular">{formatCents(engagement.totalCents, contract.currency)}</span>{' '}
            HT.
          </p>
        )}
        <EcheancierTable
          contract={contract}
          versions={versions}
          rule={tenant.prorataRule}
          until={horizon}
          currency={contract.currency}
        />
      </section>

      <section id="documents" aria-labelledby="documents-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="documents-title" className="text-sm font-semibold tracking-tight">
            Documents
          </h2>
          <Link
            href={`/contrats/${contract.id}/document`}
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            Aperçu du contrat avec les données actuelles
          </Link>
        </div>
        {documents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            {contract.status === 'draft'
              ? 'Aucun document archivé : le document du contrat est archivé, avec son empreinte, à l’activation.'
              : 'Aucun document archivé pour ce contrat, activé avant l’archivage des documents.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Versions archivées des documents du contrat</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Version</th>
                  <th scope="col" className="px-4 py-3 font-medium">Document</th>
                  <th scope="col" className="px-4 py-3 font-medium">Archivé le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Par</th>
                  <th scope="col" className="px-4 py-3 font-medium">Empreinte SHA-256</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/contrats/${contract.id}/document?version=${document.version}`}
                        className="tabular text-primary underline-offset-2 hover:underline"
                      >
                        Version {document.version}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      {document.amendmentNumber
                        ? `Avenant n° ${document.amendmentNumber}`
                        : 'Contrat'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular">
                      {formatDateTime(document.createdAt, timeZone)}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {document.generatedBy ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 font-normal tabular text-muted-foreground">
                      <span title={document.sha256}>{document.sha256.slice(0, 16)}…</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!archived &&
          contract.status !== 'draft' &&
          !hasInitialDocument &&
          can(member.role, 'contrats.avenants') && (
            <EstablishDocumentButton contractId={contract.id} />
          )}
      </section>

      {/* Seul un contrat en cours se résilie : un brouillon abandonné s'archive. */}
      {!archived && contract.status === 'active' && can(member.role, 'contrats.resilier') && (
        <TerminateForm
          contractId={contract.id}
          // Le premier dernier jour qui respecte le préavis et l'engagement
          // (`contract_earliest_end_on`, ADR 023).
          defaultTerminatedOn={earliestEndOn(today, contract.noticeDays, contract.commitmentEndsOn)}
          noticeDays={contract.noticeDays}
          commitmentEndsOn={
            contract.commitmentEndsOn && contract.commitmentEndsOn >= today
              ? contract.commitmentEndsOn
              : null
          }
        />
      )}

      {!archived && can(member.role, 'contrats.archiver') && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4">
          <p className="text-sm font-medium text-foreground">Archiver le contrat</p>
          {/* Suppression logique : le contrat reste consultable, y compris
              pour des raisons légales (décision 6). */}
          <p className="text-xs text-muted-foreground">
            Pour un brouillon abandonné ou un contrat saisi en double. Le contrat sort des listes
            et reste consultable.
          </p>
          <ArchiveButton
            contractId={contract.id}
            reference={contract.reference}
            active={contract.status === 'active'}
            resourceLabel={occupation?.status === 'confirmed' ? resourceLabel : null}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Ce que le contrat occupe, d'après la ligne que la base tient (ADR 018) :
 * occupée, levée et pourquoi, à venir à l'activation, ou en conflit à résoudre.
 * Le statut est dit en toutes lettres, jamais par la seule couleur.
 */
function OccupationSummary({
  contract,
  occupation,
  resourceLabel,
  timeZone,
  canChangeResource,
}: {
  contract: NonNullable<Awaited<ReturnType<typeof findContract>>>
  occupation: Awaited<ReturnType<typeof findContractOccupation>>
  resourceLabel: string | null
  timeZone: string
  /** Le formulaire de changement de ressource est affiché sous ce résumé. */
  canChangeResource: boolean
}) {
  const box = 'rounded-lg border border-border bg-white px-5 py-4 text-sm'

  if (!resourceLabel) {
    return (
      <p className={`${box} text-muted-foreground`}>
        Aucune ressource attribuée : ce contrat n’occupe rien dans les calendriers.
      </p>
    )
  }

  if (occupation && occupation.status !== 'cancelled') {
    const days = occupationDays(occupation, timeZone)
    const past = days.lastDay !== null && days.lastDay < todayIsoDate(timeZone)
    return (
      <div className={box}>
        <p>
          <strong className="font-medium">{past ? 'Occupation terminée' : 'Occupée'}</strong> —{' '}
          {resourceLabel}, <span className="tabular">{formatContractDays(days)}</span>.
        </p>
        <p className="mt-2 text-muted-foreground">
          {past
            ? 'La ressource est libre depuis le lendemain du dernier jour ; la période reste dans l’historique.'
            : 'La ressource n’est proposée à personne d’autre sur cette période, ni au planning ni sur la page publique.'}{' '}
          <Link
            href={`/reservations/${occupation.id}`}
            className="text-primary underline underline-offset-2"
          >
            Voir l’occupation
          </Link>
        </p>
      </div>
    )
  }

  if (contract.status === 'draft' && !contract.deletedAt) {
    return (
      <p className={box}>
        <strong className="font-medium">Pas encore occupée</strong> — un brouillon n’engage
        rien. L’activation occupera {resourceLabel}{' '}
        <span className="tabular">
          {formatContractDays({
            firstDay: contract.startsOn,
            lastDay: lastContractDay(contract),
          })}
        </span>
        .
      </p>
    )
  }

  // Le contrat devrait occuper sa ressource mais n'a pas d'occupation : la
  // reprise l'a laissé en conflit (ADR 018).
  if (contractOccupiesResource(contract)) {
    return (
      <p className={`${box} border-statut-conflit/40`}>
        <strong className="font-medium text-statut-conflit">Conflit à résoudre</strong> —{' '}
        {resourceLabel} était déjà occupée lors de la reprise des contrats : ce contrat ne
        l’occupe pas.{' '}
        {canChangeResource
          ? 'Changez de ressource ci-dessous, ou libérez celle-ci (annulez la réservation en trop, archivez le contrat en double).'
          : 'Libérez-la : annulez la réservation en trop, ou archivez le contrat en double.'}
      </p>
    )
  }

  return (
    <p className={`${box} text-muted-foreground`}>
      <strong className="font-medium text-foreground">Libérée</strong> —{' '}
      {occupation?.cancellationReason ?? 'le contrat n’occupe plus sa ressource'}.
    </p>
  )
}
