import Link from 'next/link'
import { notFound } from 'next/navigation'

import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { activateContractAction } from '../../../../modules/contrats/actions.ts'
import { addDays, noticeEndsOn } from '../../../../modules/contrats/echeancier.ts'
import { EcheancierTable } from '../../../../modules/contrats/echeancier-table.tsx'
import {
  billingPeriodLabels,
  billingPeriodSuffixes,
  contractStatusLabels,
  contractStatusStyles,
  contractTypeLabels,
} from '../../../../modules/contrats/labels.ts'
import { findContract } from '../../../../modules/contrats/queries.ts'
import { TerminateForm } from '../../../../modules/contrats/terminate-form.tsx'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Contrat' }

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { member } = await requirePermission('contrats.consulter')
  const { id } = await params
  const contract = await findContract(id)
  if (!contract) notFound()

  const today = new Date().toISOString().slice(0, 10)
  // Douze mois d'horizon : assez pour lire l'engagement en cours sans dérouler
  // une durée indéterminée jusqu'à la fin des temps.
  const horizon = addDays(today, 365)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/contrats" className="text-sm text-muted-foreground hover:underline">
          ← Contrats
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{contract.reference}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${contractStatusStyles[contract.status]}`}
          >
            {contractStatusLabels[contract.status]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {contractTypeLabels[contract.contractType]} —{' '}
          <Link href={`/clients/${contract.clientId}`} className="underline-offset-2 hover:underline">
            {contract.client.name}
          </Link>
        </p>
      </div>

      {contract.status === 'draft' && can(member.role, 'contrats.activer') && (
        <form action={activateContractAction} className="flex items-center gap-3">
          <input type="hidden" name="id" value={contract.id} />
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Activer le contrat
          </button>
          <span className="text-xs text-muted-foreground">
            Un brouillon n’est pas facturable.
          </span>
        </form>
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
        <dd>{contract.startsOn}</dd>

        <dt className="text-muted-foreground">Terme</dt>
        <dd>{contract.endsOn ?? 'Durée indéterminée'}</dd>

        <dt className="text-muted-foreground">Préavis</dt>
        <dd>{contract.noticeDays} jours</dd>

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
            <dd>{contract.terminatedOn}</dd>
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

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Échéancier prévisionnel</h2>
        <p className="text-xs text-muted-foreground">
          Périodes civiles, prorata temporis au jour sur les périodes partielles. Calculé à la
          lecture, jamais figé en base.
        </p>
        <EcheancierTable contract={contract} until={horizon} currency={contract.currency} />
      </section>

      {contract.status !== 'terminated' && can(member.role, 'contrats.resilier') && (
        <TerminateForm
          contractId={contract.id}
          defaultTerminatedOn={noticeEndsOn(today, contract.noticeDays)}
          noticeDays={contract.noticeDays}
        />
      )}
    </div>
  )
}
