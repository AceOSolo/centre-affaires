import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import {
  billingPeriodSuffixes,
  contractStatusLabels,
  contractStatusStyles,
  contractTypeLabels,
} from '../../../modules/contrats/labels.ts'
import { formatContractDays, lastContractDay } from '../../../modules/contrats/occupation.ts'
import { listContracts } from '../../../modules/contrats/queries.ts'
import { contractStatuses, type ContractStatus } from '../../../modules/contrats/schema.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Contrats' }

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ statut?: string; archives?: string }>
}) {
  const { member } = await requirePermission('contrats.consulter')
  const { statut, archives } = await searchParams
  const status = contractStatuses.includes(statut as ContractStatus)
    ? (statut as ContractStatus)
    : undefined
  // Les archivés sont exclus par défaut (décision 6) et s'affichent à part.
  const archived = archives === '1'
  const contracts = await listContracts({ status, archived })
  const filterHref = (value?: ContractStatus) => {
    const query = new URLSearchParams()
    if (value) query.set('statut', value)
    if (archived) query.set('archives', '1')
    const search = query.toString()
    return search ? `/contrats?${search}` : '/contrats'
  }

  // Le récurrent ne s'additionne qu'à périodicité égale : mélanger un mensuel
  // et un annuel dans un même total ne voudrait rien dire. Un contrat archivé
  // ne compte pas.
  const mensuelCents = archived
    ? 0
    : contracts
        .filter((contract) => contract.status === 'active' && contract.billingPeriod === 'monthly')
        .reduce((total, contract) => total + contract.amountCents, 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contrats</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Domiciliations, bureaux et prestations récurrentes.
          </p>
        </div>
        {can(member.role, 'contrats.creer') && (
          <Link
            href="/contrats/nouveau"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Nouveau contrat
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterLink href={filterHref()} label="Tous" active={!status} />
        {contractStatuses.map((value) => (
          <FilterLink
            key={value}
            href={filterHref(value)}
            label={contractStatusLabels[value]}
            active={status === value}
          />
        ))}
        <Link
          href={archived ? '/contrats' : '/contrats?archives=1'}
          className="rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          {archived ? 'Masquer les archivés' : 'Afficher les archivés'}
        </Link>
        {mensuelCents > 0 && (
          <p className="ml-auto text-sm text-muted-foreground">
            Récurrent mensuel en cours :{' '}
            <span className="font-medium tabular-nums text-foreground">
              {formatCents(mensuelCents)}
            </span>
          </p>
        )}
      </div>

      {archived && (
        <p className="text-sm text-muted-foreground">
          Contrats archivés : ils sortent des listes et n’occupent plus leur ressource, mais restent
          consultables et peuvent être désarchivés depuis leur fiche.
        </p>
      )}

      {contracts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {archived
              ? 'Aucun contrat archivé.'
              : status
                ? 'Aucun contrat dans cet état.'
                : 'Aucun contrat pour l’instant.'}
          </p>
          {archived ? (
            <Link
              href="/contrats"
              className="mt-4 inline-block rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Revenir aux contrats
            </Link>
          ) : can(member.role, 'contrats.creer') ? (
            <Link
              href="/contrats/nouveau"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Créer un contrat
            </Link>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              La création des contrats est réservée à l’exploitant.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Référence</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Période</th>
                <th className="px-4 py-3 text-right font-medium">Montant</th>
                <th className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contracts.map((contract) => (
                <tr key={contract.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/contrats/${contract.id}`}
                      className="tabular underline-offset-2 hover:underline"
                    >
                      {contract.reference}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/clients/${contract.clientId}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {contract.client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {contractTypeLabels[contract.contractType]}
                    {contract.resource && (
                      <span className="ml-2 text-xs">{contract.resource.code}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                    {formatContractDays({
                      firstDay: contract.startsOn,
                      lastDay: lastContractDay(contract),
                    })}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {formatCents(contract.amountCents, contract.currency)}{' '}
                    <span className="text-xs text-muted-foreground">
                      {billingPeriodSuffixes[contract.billingPeriod]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${contractStatusStyles[contract.status]}`}
                    >
                      {contractStatusLabels[contract.status]}
                    </span>
                    {contract.deletedAt && (
                      <span className="ml-2 inline-block rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                        Archivé
                      </span>
                    )}
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

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
 active
 ? 'border-primary bg-primary text-white'
 : 'border-border text-muted-foreground hover:border-border'
 }`}
    >
      {label}
    </Link>
  )
}
