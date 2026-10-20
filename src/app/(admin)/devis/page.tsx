import Link from 'next/link'

import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { ProposalStatusBadge } from '../../../modules/facturation/proposal-status.tsx'
import {
  emptyGroupMessages,
  parseStatusGroup,
  proposalStatusGroupLabels,
  proposalStatusGroupStatuses,
  proposalStatusGroups,
} from '../../../modules/facturation/propositions-ecran.ts'
import { listProposals } from '../../../modules/facturation/propositions-queries.ts'
import { proposalProductLabels } from '../../../modules/facturation/propositions.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Devis' }

/**
 * Devis transmis à Dolibarr (ADR 043) : la file de l'accueil. « À compléter »
 * d'abord, ce qui attend un prix ou une relecture ; les devis validés partent
 * ensuite d'eux-mêmes vers Dolibarr.
 */
export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{ statut?: string | string[] }>
}) {
  await requirePermission('demandes.traiter')
  const [{ statut }, timeZone] = await Promise.all([searchParams, currentTimeZone()])
  const group = parseStatusGroup(statut)
  const proposals = await listProposals({ statuses: proposalStatusGroupStatuses[group] })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devis</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Chaque demande du site ou de l’espace client dépose son devis. L’accueil le complète et le
            valide ; Dolibarr reprend les devis validés, les envoie et en fait la facture.
          </p>
        </div>
        <Link
          href="/devis/nouveau"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Nouveau devis
        </Link>
      </div>

      <nav aria-label="Filtrer les devis par état" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {proposalStatusGroups.map((candidate) => (
          <Link
            key={candidate}
            href={candidate === 'a-completer' ? '/devis' : `/devis?statut=${candidate}`}
            aria-current={candidate === group ? 'page' : undefined}
            className="rounded-sm border-b-2 border-transparent pb-0.5 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-primary"
          >
            {proposalStatusGroupLabels[candidate]}
          </Link>
        ))}
      </nav>

      {proposals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="mx-auto max-w-prose text-sm text-muted-foreground">{emptyGroupMessages[group]}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-4">
            <Link
              href="/devis/nouveau"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Établir un devis
            </Link>
            {group !== 'tous' && (
              <Link href="/devis?statut=tous" className="self-center text-sm text-primary underline-offset-2 hover:underline">
                Voir tous les devis
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Devis : {proposalStatusGroupLabels[group].toLowerCase()}</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Numéro</th>
                <th scope="col" className="px-4 py-3 font-medium">Produit</th>
                <th scope="col" className="px-4 py-3 font-medium">Destinataire</th>
                <th scope="col" className="px-4 py-3 font-medium">Créneau</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
                <th scope="col" className="px-4 py-3 font-medium">Créé le</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {proposals.map((proposal) => (
                <tr key={proposal.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link
                      href={`/devis/${proposal.id}`}
                      className="font-medium text-primary underline-offset-2 hover:underline tabular"
                    >
                      {proposal.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{proposalProductLabels[proposal.product]}</td>
                  <td className="px-4 py-3">
                    {proposal.clientName ?? proposal.requesterCompany ?? proposal.requesterName ?? proposal.requesterEmail ?? '—'}
                    <span className="block text-xs text-muted-foreground">
                      {proposal.clientName
                        ? 'Client'
                        : proposal.requesterCompany && proposal.requesterName
                          ? `Prospect · ${proposal.requesterName}`
                          : 'Prospect'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {proposal.resourceName ? (
                      <>
                        {proposal.resourceName}
                        {proposal.bookingStartsAt && (
                          <span className="block text-xs text-muted-foreground tabular">
                            {formatDateTime(proposal.bookingStartsAt, timeZone)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                    {proposal.lineCount === 0 ? (
                      <span className="text-muted-foreground">Sans prix</span>
                    ) : (
                      formatCents(proposal.netCents, proposal.currency)
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ProposalStatusBadge status={proposal.status} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground tabular">
                    {formatDateTime(proposal.createdAt, timeZone)}
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
