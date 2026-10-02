import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CheckIcon } from '../../../../components/ui/icons.tsx'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { archiveClientAction } from '../../../../modules/clients/actions.ts'
import { listClientContacts } from '../../../../modules/clients/contacts-queries.ts'
import { phoneHref } from '../../../../modules/clients/contacts-regles.ts'
import {
  formatBookingDay,
  formatBookingHours,
  formatIsoDay,
  listClientBookingHistory,
  type ClientBookingRow,
} from '../../../../modules/clients/historique.ts'
import { listClientMembers } from '../../../../modules/clients/comptes.ts'
import { removeClientMemberAction } from '../../../../modules/clients/comptes-actions.ts'
import { MemberForm } from '../../../../modules/clients/member-form.tsx'
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
import {
  bookingStatusBadgeStyles,
  bookingStatusLabels,
} from '../../../../modules/reservations/labels.ts'

export const metadata = { title: 'Client' }

/**
 * Confirmations des écritures de contacts, après le retour sur la fiche. Une
 * `Map` et non un objet : `?contact=constructor` ne doit rien trouver.
 */
const contactNotices = new Map([
  ['ajoute', 'Contact ajouté.'],
  ['modifie', 'Contact enregistré.'],
  ['retire', 'Contact retiré de la fiche.'],
])

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ contact?: string }>
}) {
  const { member: staff } = await requirePermission('clients.gerer')
  const [{ id }, { contact: contactNotice }] = await Promise.all([params, searchParams])
  // Un identifiant illisible ferait lever Postgres (22P02) : c'est une fiche
  // introuvable, pas une panne.
  if (!isUuid(id)) notFound()
  const client = await findClient(id)
  if (!client) notFound()

  const [contracts, members, contacts, history, timeZone] = await Promise.all([
    listContracts({ clientId: client.id }),
    listClientMembers(client.id),
    listClientContacts(client.id),
    listClientBookingHistory(client.id),
    currentTimeZone(),
  ])
  const address = formatAddress(client)
  const notice = typeof contactNotice === 'string' ? contactNotices.get(contactNotice) : undefined
  const hasPrimary = contacts.some((contact) => contact.isPrimary)

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

      {notice && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
        >
          <CheckIcon size={20} />
          {notice}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/clients/${client.id}/modifier`}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Modifier la fiche
        </Link>
        {can(staff.role, 'contrats.creer') && (
          <Link
            href={`/contrats/nouveau?clientId=${client.id}`}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Nouveau contrat
          </Link>
        )}
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

      <section id="contacts" aria-labelledby="contacts-titre" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="contacts-titre" className="text-sm font-semibold tracking-tight">
            Contacts{' '}
            <span className="font-normal text-muted-foreground">({contacts.length})</span>
          </h2>
          {!client.deletedAt && (
            <Link
              href={`/clients/${client.id}/contacts/nouveau`}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Ajouter un contact
            </Link>
          )}
        </div>
        {/* Contacts et accès sont deux listes distinctes (R07, ADR 015) : le
            comptable qui reçoit les factures n'a pas à ouvrir l'espace client. */}
        <p className="text-sm text-muted-foreground">
          Les interlocuteurs de l’entreprise pour le centre : qui joindre, qui reçoit les factures.
          Un contact n’a pas accès à l’espace client ; les accès se donnent plus bas, dans
          « Accès à l’espace client ».
        </p>

        {contacts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Aucun contact enregistré.
            {!client.deletedAt && (
              <>
                {' '}
                Commencez par l’interlocuteur principal :{' '}
                <Link
                  href={`/clients/${client.id}/contacts/nouveau`}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  ajouter un contact
                </Link>
                .
              </>
            )}
          </p>
        ) : (
          <>
            {!hasPrimary && !client.deletedAt && (
              <p className="text-sm text-foreground">
                Aucun contact principal : modifiez l’un des contacts et cochez « Contact principal ».
              </p>
            )}
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table aria-labelledby="contacts-titre" className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Nom</th>
                    <th scope="col" className="px-4 py-3 font-medium">Courriel</th>
                    <th scope="col" className="px-4 py-3 font-medium">Téléphone</th>
                    <th scope="col" className="px-4 py-3 font-medium">Rôle</th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td className="px-4 py-3">
                        <span className="font-medium">{contact.fullName}</span>
                        {contact.jobTitle && (
                          <span className="block text-xs text-muted-foreground">
                            {contact.jobTitle}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {contact.email ? (
                          <a
                            href={`mailto:${contact.email}`}
                            className="underline-offset-2 hover:underline"
                          >
                            {contact.email}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular">
                        {contact.phone ? (
                          <a
                            href={phoneHref(contact.phone)}
                            className="underline-offset-2 hover:underline"
                          >
                            {contact.phone}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {/* Le rôle se lit au libellé, la teinte ne fait que
                            l'accompagner. */}
                        {contact.isPrimary || contact.isBilling ? (
                          <span className="flex flex-wrap gap-1">
                            {contact.isPrimary && (
                              <span className="inline-block rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                                Principal
                              </span>
                            )}
                            {contact.isBilling && (
                              <span className="inline-block rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
                                Factures
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!client.deletedAt && (
                          <Link
                            href={`/clients/${client.id}/contacts/${contact.id}`}
                            aria-label={`Modifier le contact ${contact.fullName}`}
                            className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Modifier
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Contrats{' '}
          <span className="font-normal text-muted-foreground">({contracts.length})</span>
        </h2>

        {contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun contrat pour ce client. « Nouveau contrat », en haut de la fiche, en prépare un.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Référence</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Ressource</th>
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
                        className="font-medium tabular underline-offset-2 hover:underline"
                      >
                        {contract.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {contractTypeLabels[contract.contractType]}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {contract.resource?.name ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                      {formatIsoDay(contract.startsOn)} →{' '}
                      {contract.terminatedOn
                        ? formatIsoDay(contract.terminatedOn)
                        : contract.endsOn
                          ? formatIsoDay(contract.endsOn)
                          : 'sans terme'}
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

      <section aria-labelledby="reservations-titre" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="reservations-titre" className="text-sm font-semibold tracking-tight">
            Réservations{' '}
            <span className="font-normal text-muted-foreground">
              ({history.upcomingTotal + history.pastTotal})
            </span>
          </h2>
          {!client.deletedAt && (
            <Link
              href={`/reservations/nouvelle?clientId=${client.id}`}
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              Nouvelle réservation
            </Link>
          )}
        </div>

        {history.upcomingTotal + history.pastTotal === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Aucune réservation pour ce client. Une réservation lui est rattachée en le choisissant à
            la création, ou depuis la fiche de la réservation.
          </p>
        ) : (
          <>
            <BookingHistoryTable
              id="reservations-a-venir"
              title="À venir et en cours"
              rows={history.upcoming}
              total={history.upcomingTotal}
              timeZone={timeZone}
              empty="Aucune réservation à venir."
              truncated={`Les ${history.upcoming.length} plus proches sur ${history.upcomingTotal}.`}
            />
            <BookingHistoryTable
              id="reservations-passees"
              title="Passées"
              rows={history.past}
              total={history.pastTotal}
              timeZone={timeZone}
              empty="Aucune réservation passée."
              truncated={`Les ${history.past.length} plus récentes sur ${history.pastTotal}.`}
            />
          </>
        )}
      </section>

      {/* Place réservée aux services souscrits (R18, vague 2). Un tableau vide
          dirait « aucun service » d'un client qui en a : le texte dit plutôt
          que le suivi n'existe pas encore. */}
      <section aria-labelledby="services-titre" className="flex flex-col gap-3">
        <h2 id="services-titre" className="text-sm font-semibold tracking-tight">
          Services souscrits
        </h2>
        <div className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm">
          <p className="font-medium text-foreground">Pas encore suivis dans l’application</p>
          <p className="mt-1 text-muted-foreground">
            Les forfaits et les actes — standard, assistante, numérisation du courrier — seront
            rattachés à la fiche avec la facturation. D’ici là, cette rubrique ne dit pas ce que le
            client a souscrit : ses prestations récurrentes figurent dans ses contrats.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">
            Accès à l’espace client{' '}
            <span className="font-normal text-muted-foreground">({members.length})</span>
          </h2>
          <div className="flex gap-4 text-sm">
            <Link
              href={`/courrier?client=${client.id}`}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              Courrier de ce client
            </Link>
            {!client.deletedAt && (
              <Link
                href={`/courrier/nouveau?clientId=${client.id}`}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Enregistrer un courrier
              </Link>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Ces personnes consultent le courrier de l’entreprise et en demandent l’ouverture. Chacune
          crée son accès depuis la page de connexion du site, avec l’adresse inscrite ici. Un accès
          n’est pas un contact : il ouvre l’espace client, sans faire de la personne un
          interlocuteur du centre.
        </p>

        {members.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Adresse</th>
                  <th className="px-4 py-3 font-medium">Nom</th>
                  <th className="px-4 py-3 font-medium">Accès</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.map((member) => (
                  <tr key={member.id}>
                    <td className="px-4 py-3">{member.email}</td>
                    <td className="px-4 py-3 text-muted-foreground">{member.fullName ?? '—'}</td>
                    <td className="px-4 py-3">
                      {/* Libellé et couleur : l'état ne se lit pas qu'à la teinte. */}
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          member.authUserId
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-accent/15 text-primary'
                        }`}
                      >
                        {member.authUserId ? 'Compte activé' : 'En attente de connexion'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={removeClientMemberAction}>
                        <input type="hidden" name="id" value={member.id} />
                        <input type="hidden" name="clientId" value={client.id} />
                        <button
                          type="submit"
                          aria-label={`Retirer l’accès de ${member.email}`}
                          className="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                        >
                          Retirer l’accès
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!client.deletedAt && (
          <div className="rounded-lg border border-border bg-white px-5 py-4">
            <MemberForm clientId={client.id} />
          </div>
        )}
      </section>

      {!client.deletedAt && can(staff.role, 'clients.archiver') && (
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

/**
 * Une moitié de l'historique des réservations : à venir, ou passées. L'état
 * se lit au libellé, jamais à la seule teinte du badge (ADR 004).
 */
function BookingHistoryTable({
  id,
  title,
  rows,
  total,
  timeZone,
  empty,
  truncated,
}: {
  id: string
  title: string
  rows: ClientBookingRow[]
  total: number
  timeZone: string
  empty: string
  /** Dit que la liste est bornée, quand elle l'est. */
  truncated: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 id={id} className="text-sm font-medium text-foreground">
        {title} <span className="font-normal text-muted-foreground">({total})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table aria-labelledby={id} className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Date</th>
                <th scope="col" className="px-4 py-3 font-medium">Horaire</th>
                <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
                <th scope="col" className="px-4 py-3 font-medium">Objet</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((booking) => (
                <tr key={booking.id}>
                  <td className="whitespace-nowrap px-4 py-3 tabular">
                    {formatBookingDay(booking.startsAt, timeZone)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                    {formatBookingHours(booking, timeZone)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{booking.resourceName}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/reservations/${booking.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {booking.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeStyles[booking.status]}`}
                    >
                      {bookingStatusLabels[booking.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > rows.length && <p className="text-xs text-muted-foreground">{truncated}</p>}
    </div>
  )
}
