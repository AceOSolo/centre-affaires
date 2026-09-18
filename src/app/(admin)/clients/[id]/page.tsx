import Link from 'next/link'
import { notFound } from 'next/navigation'

import { archiveClientAction } from '../../../../modules/clients/actions.ts'
import {
  clientStatusLabels,
  clientStatusStyles,
  formatAddress,
  formatSiret,
} from '../../../../modules/clients/labels.ts'
import { findClient } from '../../../../modules/clients/queries.ts'
import {
  billingPeriodSuffixes,
  contractStatusLabels,
  contractStatusStyles,
  contractTypeLabels,
} from '../../../../modules/contrats/labels.ts'
import { listContracts } from '../../../../modules/contrats/queries.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Client' }

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = await findClient(id)
  if (!client) notFound()

  const contracts = await listContracts({ clientId: client.id })
  const address = formatAddress(client)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${clientStatusStyles[client.status]}`}
          >
            {clientStatusLabels[client.status]}
          </span>
          {client.deletedAt && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              Fiche archivée
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/clients/${client.id}/modifier`}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Modifier la fiche
        </Link>
        <Link
          href={`/contrats/nouveau?clientId=${client.id}`}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Nouveau contrat
        </Link>
      </div>

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Forme juridique</dt>
        <dd>{client.legalForm ?? '—'}</dd>

        <dt className="text-muted-foreground">SIRET</dt>
        <dd className="font-mono text-xs">{formatSiret(client.siret)}</dd>

        <dt className="text-muted-foreground">N° TVA</dt>
        <dd className="font-mono text-xs">{client.vatNumber ?? '—'}</dd>

        <dt className="text-muted-foreground">Adresse</dt>
        <dd>{address || '—'}</dd>

        <dt className="text-muted-foreground">Courriel</dt>
        <dd>
          {client.email ? (
            <a href={`mailto:${client.email}`} className="underline-offset-2 hover:underline">
              {client.email}
            </a>
          ) : (
            '—'
          )}
        </dd>

        <dt className="text-muted-foreground">Téléphone</dt>
        <dd>{client.phone ?? '—'}</dd>

        {client.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{client.notes}</dd>
          </>
        )}
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Contrats{' '}
          <span className="font-normal text-muted-foreground">({contracts.length})</span>
        </h2>

        {contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun contrat pour ce client.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Référence</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Début</th>
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
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {contract.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {contractTypeLabels[contract.contractType]}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {contract.startsOn}
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!client.deletedAt && (
        <form
          action={archiveClientAction}
          className="rounded-lg border border-border bg-white px-5 py-4"
        >
          <input type="hidden" name="id" value={client.id} />
          <p className="text-sm font-medium text-foreground">Archiver le client</p>
          {/* Suppression logique : les contrats et les factures restent
              consultables, y compris pour des raisons légales (décision 6). */}
          <p className="mt-1 text-xs text-muted-foreground">
            La fiche sort des listes. Ses contrats restent consultables.
          </p>
          <button
            type="submit"
            className="mt-3 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
          >
            Archiver
          </button>
        </form>
      )}
    </div>
  )
}
