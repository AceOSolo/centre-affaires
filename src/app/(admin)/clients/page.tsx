import Link from 'next/link'

import { clientStatusLabels, clientStatusStyles, formatSiret } from '../../../modules/clients/labels.ts'
import { listClients } from '../../../modules/clients/queries.ts'
import { clientStatuses, type ClientStatus } from '../../../modules/clients/schema.ts'

export const metadata = { title: 'Clients' }

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ statut?: string; q?: string }>
}) {
  const { statut, q } = await searchParams
  const status = clientStatuses.includes(statut as ClientStatus)
    ? (statut as ClientStatus)
    : undefined
  const clients = await listClients({ status, search: q })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Entreprises domiciliées et locataires du centre.
          </p>
        </div>
        <Link
          href="/clients/nouveau"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Nouveau client
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterLink href="/clients" label="Tous" active={!status} />
        {clientStatuses.map((value) => (
          <FilterLink
            key={value}
            href={`/clients?statut=${value}`}
            label={clientStatusLabels[value]}
            active={status === value}
          />
        ))}
        {/* Formulaire GET : la recherche marche sans JavaScript et reste dans l'URL. */}
        <form className="ml-auto flex items-center gap-2">
          <label htmlFor="q" className="sr-only">
            Rechercher un client
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Nom, SIRET, ville"
            className="rounded-md border border-border bg-white px-3 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
          >
            Rechercher
          </button>
        </form>
      </div>

      {clients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {q || status
              ? 'Aucun client ne correspond à cette recherche.'
              : 'Aucun client pour l’instant. Les contrats s’appuient sur cette liste.'}
          </p>
          <Link
            href="/clients/nouveau"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Créer un client
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Raison sociale</th>
                <th className="px-4 py-3 font-medium">SIRET</th>
                <th className="px-4 py-3 font-medium">Ville</th>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {clients.map((client) => (
                <tr key={client.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/clients/${client.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {client.name}
                    </Link>
                    {client.legalForm && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {client.legalForm}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                    {formatSiret(client.siret)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {client.city ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {client.email ?? client.phone ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${clientStatusStyles[client.status]}`}
                    >
                      {clientStatusLabels[client.status]}
                    </span>
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
