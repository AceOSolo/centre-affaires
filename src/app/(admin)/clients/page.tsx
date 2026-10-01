import Link from 'next/link'

import { clientStatusLabels, clientStatusStyles, formatSiret } from '../../../modules/clients/labels.ts'
import { searchClients } from '../../../modules/clients/recherche.ts'
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
  const search = q?.trim() ?? ''
  const clients = await searchClients({ status, search })

  /** Lien de filtre qui garde la recherche en cours : les deux se combinent. */
  const filterHref = (value?: ClientStatus) => {
    const query = new URLSearchParams()
    if (value) query.set('statut', value)
    if (search) query.set('q', search)
    const encoded = query.toString()
    return encoded ? `/clients?${encoded}` : '/clients'
  }

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

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <nav aria-label="Filtrer par statut" className="flex flex-wrap items-center gap-2">
          <FilterLink href={filterHref()} label="Tous" active={!status} />
          {clientStatuses.map((value) => (
            <FilterLink
              key={value}
              href={filterHref(value)}
              label={clientStatusLabels[value]}
              active={status === value}
            />
          ))}
        </nav>
        {/* Formulaire GET : la recherche marche sans JavaScript et reste dans
            l'URL. Le statut choisi y est repris, pour que chercher ne le perde pas. */}
        <form role="search" className="ml-auto flex flex-wrap items-end gap-2">
          {status && <input type="hidden" name="statut" value={status} />}
          <div>
            <label htmlFor="q" className="block text-xs font-medium text-foreground">
              Rechercher
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search}
              aria-describedby="q-hint"
              className="mt-1 w-64 rounded-sm border border-border bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Rechercher
          </button>
          <p id="q-hint" className="basis-full text-right text-xs text-muted-foreground">
            Raison sociale, SIRET, nom d’un contact ou ville.
          </p>
        </form>
      </div>

      {/* Annoncé après une recherche ou un filtre : la page se recharge, le
          nombre de résultats dit ce qu'elle a trouvé. */}
      {(search || status) && (
        <p role="status" className="-mt-2 text-sm text-muted-foreground">
          {clients.length === 0
            ? 'Aucun client trouvé'
            : `${clients.length} client${clients.length > 1 ? 's' : ''} trouvé${clients.length > 1 ? 's' : ''}`}
          {search && <> pour « {search} »</>}
          {status && <> parmi les fiches « {clientStatusLabels[status]} »</>}.{' '}
          <Link href="/clients" className="text-primary underline underline-offset-2">
            Tout afficher
          </Link>
        </p>
      )}

      {clients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {search || status
              ? 'Aucun client ne correspond à cette recherche. Vérifiez l’orthographe, cherchez le SIRET ou le nom d’un contact, ou créez la fiche.'
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
                  <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                    {formatSiret(client.siret)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {client.city ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {client.primaryContact ? (
                      <>
                        <span className="text-foreground">{client.primaryContact.fullName}</span>
                        {client.primaryContact.jobTitle && <>, {client.primaryContact.jobTitle}</>}
                        <span className="block text-xs">
                          {client.primaryContact.email ?? client.primaryContact.phone ?? client.email ?? client.phone}
                        </span>
                      </>
                    ) : (
                      (client.email ?? client.phone ?? '—')
                    )}
                    {/* Dit pourquoi la fiche est remontée quand c'est un contact
                        qui correspond, et pas la raison sociale. */}
                    {client.matchedContactNames &&
                      client.matchedContactNames !== client.primaryContact?.fullName && (
                        <span className="mt-1 block text-xs">
                          Contact trouvé :{' '}
                          <mark className="bg-accent/15 text-foreground">
                            {client.matchedContactNames}
                          </mark>
                        </span>
                      )}
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
