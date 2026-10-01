import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import {
  ActivateForm,
  ArchiveButton,
  ResourceForm,
  RestoreForm,
} from '../../../../modules/contrats/contract-actions.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import {
  addDays,
  commitmentSchedule,
  earliestEndOn,
} from '../../../../modules/contrats/echeancier.ts'
import { loadContractScheduleOptions } from '../../../../modules/contrats/echeancier-queries.ts'
import { EcheancierTable } from '../../../../modules/contrats/echeancier-table.tsx'
import {
  billingPeriodLabels,
  billingPeriodSuffixes,
  contractStatusLabels,
  contractStatusStyles,
  contractTypeLabels,
} from '../../../../modules/contrats/labels.ts'
import {
  canChangeContractResource,
  contractOccupiesResource,
  formatCalendarDate,
  formatContractDays,
  lastContractDay,
  occupationDays,
} from '../../../../modules/contrats/occupation.ts'
import { findContract, findContractOccupation } from '../../../../modules/contrats/queries.ts'
import { TerminateForm } from '../../../../modules/contrats/terminate-form.tsx'
import { prorataRuleLabels } from '../../../../modules/facturation/parametres-libelles.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Contrat' }

/** Confirmations affichées après une action, selon `?fait=`. */
const notices: Record<string, string> = {
  modifie: 'Brouillon enregistré.',
  active: 'Contrat activé : il est facturable et occupe sa ressource.',
  ressource: 'Ressource changée : l’occupation a suivi.',
  resilie: 'Contrat résilié : la ressource est libre au lendemain du dernier jour.',
  archive: 'Contrat archivé. Il n’apparaît plus dans la liste, sauf filtre « Archivés ».',
  restaure: 'Contrat désarchivé.',
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
  const [contract, occupation, timeZone, scheduleOptions] = await Promise.all([
    findContract(id),
    findContractOccupation(id),
    currentTimeZone(),
    // Règle de prorata du centre et versions de prix du contrat (R10, ADR 025).
    loadContractScheduleOptions(id),
  ])
  if (!contract) notFound()

  const archived = contract.deletedAt !== null
  // Le jour du centre, pas celui du serveur (décision 4).
  const today = todayIsoDate(timeZone)
  // La ressource ne change qu'avant le début du contrat (ADR 018) : après, son
  // occupation serait réécrite depuis le premier jour.
  const canManageOccupation = !archived && can(member.role, 'contrats.activer')
  const canChangeResource = canManageOccupation && canChangeContractResource(contract, today)
  const resources = canChangeResource ? await listResources() : []

  // Douze mois d'horizon, et au moins jusqu'à la fin de l'engagement : assez
  // pour le lire sans dérouler une durée indéterminée jusqu'à la fin des temps.
  const twelveMonths = addDays(today, 365)
  const horizon =
    contract.commitmentEndsOn && contract.commitmentEndsOn > twelveMonths
      ? contract.commitmentEndsOn
      : twelveMonths
  const engagement = commitmentSchedule(contract, scheduleOptions)
  const resourceLabel = contract.resource
    ? `${contract.resource.name} (${contract.resource.code})`
    : null
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
              <Link
                href={`/contrats/${contract.id}/modifier`}
                className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                Modifier le brouillon
              </Link>
            )}
          </div>
        )}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Montant</dt>
        <dd className="tabular-nums">
          {formatCents(contract.amountCents, contract.currency)}{' '}
          <span className="text-muted-foreground">
            {billingPeriodSuffixes[contract.billingPeriod]} — facturation{' '}
            {billingPeriodLabels[contract.billingPeriod].toLowerCase()}
          </span>
        </dd>

        <dt className="text-muted-foreground">Début</dt>
        <dd className="tabular">{formatCalendarDate(contract.startsOn)}</dd>

        <dt className="text-muted-foreground">Terme</dt>
        <dd className="tabular">
          {contract.endsOn ? formatCalendarDate(contract.endsOn) : 'Durée indéterminée'}
        </dd>

        <dt className="text-muted-foreground">Préavis</dt>
        <dd>{contract.noticeDays} jours</dd>

        <dt className="text-muted-foreground">Engagement</dt>
        <dd>
          {contract.commitmentMonths && contract.commitmentEndsOn ? (
            <>
              {contract.commitmentMonths} mois, jusqu’au{' '}
              <span className="tabular">{formatCalendarDate(contract.commitmentEndsOn)}</span>
            </>
          ) : (
            'Sans engagement'
          )}
          {contract.tacitRenewal && contract.renewalMonths && (
            <span className="block text-muted-foreground">
              Reconduction tacite par périodes de {contract.renewalMonths} mois, sauf préavis.
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Ressource</dt>
        <dd>
          {contract.resource
            ? `${contract.resource.name} (${contract.resource.code} · ${resourceTypeLabels[contract.resource.resourceType]})`
            : '—'}
        </dd>

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

      <section aria-labelledby="occupation-title" className="flex flex-col gap-3">
        <h2 id="occupation-title" className="text-sm font-semibold tracking-tight">
          Occupation de la ressource
        </h2>
        <OccupationSummary
          contract={contract}
          occupation={occupation}
          resourceLabel={resourceLabel}
          timeZone={timeZone}
          canChangeResource={canChangeResource}
        />
        {canChangeResource ? (
          <ResourceForm
            contractId={contract.id}
            resourceId={contract.resourceId}
            resources={resources}
          />
        ) : (
          canManageOccupation &&
          contract.status === 'active' && (
            <p className="text-xs text-muted-foreground">
              Ce contrat a commencé le{' '}
              <span className="tabular">{formatCalendarDate(contract.startsOn)}</span> : sa
              ressource ne change plus. Pour passer sur une autre ressource, résiliez-le, puis
              créez un nouveau contrat sur celle-ci.
            </p>
          )
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Échéancier prévisionnel</h2>
        <p className="text-xs text-muted-foreground">
          Périodes civiles ; prorata des périodes partielles selon la règle du centre :{' '}
          {prorataRuleLabels[scheduleOptions.prorataRule].label.toLowerCase()}. Chaque période est
          facturée aux lignes de sa version, remises comprises. Calculé à la lecture, jamais figé
          en base.
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
          until={horizon}
          currency={contract.currency}
          options={scheduleOptions}
        />
      </section>

      {/* Seul un contrat en cours se résilie : un brouillon abandonné s'archive. */}
      {!archived && contract.status === 'active' && can(member.role, 'contrats.resilier') && (
        <TerminateForm
          contractId={contract.id}
          // Le premier dernier jour qui respecte le préavis et l'engagement
          // (`contract_earliest_end_on`, ADR 023).
          defaultTerminatedOn={earliestEndOn(today, contract.noticeDays, contract.commitmentEndsOn)}
          noticeDays={contract.noticeDays}
          commitmentEndsOn={contract.commitmentEndsOn}
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
