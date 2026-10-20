import Link from 'next/link'
import { notFound } from 'next/navigation'

import { withTenant } from '../../../../db/index.ts'
import { staffRoleLabels } from '../../../../db/staff.ts'
import { formatCalendarDate, formatDateTime, toIsoDate, todayIsoDate } from '../../../../lib/dates.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { currentTenantId, currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import { AccountStateBadge } from '../../../../modules/comptes/account-state-badge.tsx'
import { AttachForm } from '../../../../modules/comptes/attach-form.tsx'
import { BanForm } from '../../../../modules/comptes/ban-form.tsx'
import { findAccount } from '../../../../modules/comptes/comptes.ts'
import { LiftButton } from '../../../../modules/comptes/lift-button.tsx'
import { accountStateLabel, banLastDay, isBanActive } from '../../../../modules/comptes/regles.ts'

export const metadata = { title: 'Compte' }

/** Un compte du site : ce qui le relie au centre, son état, ses bannissements (ADR 045). */
export default async function ComptePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePermission('comptes.gerer')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const timeZone = await currentTimeZone()
  const [account, clients] = await Promise.all([
    withTenant(currentTenantId(), (tx) => findAccount(tx, id)),
    listClients(),
  ])
  if (!account) notFound()

  const banned = account.state.kind === 'banni'
  const self = account.id === user.id
  const linked = new Set(account.companies.map((company) => company.clientId))

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link href="/comptes" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Comptes
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{account.name || account.email}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span>{account.email}</span>
          <AccountStateBadge banned={banned} label={accountStateLabel(account.state, timeZone)} />
        </div>
      </div>

      <dl className="grid gap-x-8 gap-y-2 rounded-lg border border-border bg-white px-5 py-4 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Inscrit le</dt>
        <dd className="tabular">{formatCalendarDate(toIsoDate(account.createdAt, timeZone))}</dd>
        <dt className="text-muted-foreground">Adresse</dt>
        <dd>{account.emailVerified ? 'Confirmée' : 'Non confirmée : aucune fiche client n’est créée avant.'}</dd>
        <dt className="text-muted-foreground">Équipe</dt>
        <dd>{account.staffRole ? staffRoleLabels[account.staffRole] : 'Non'}</dd>
        <dt className="text-muted-foreground">Entreprises</dt>
        <dd>
          {account.companies.length === 0 ? (
            'Aucune'
          ) : (
            <ul>
              {account.companies.map((company) => (
                <li key={company.clientId}>
                  <Link
                    href={`/clients/${company.clientId}`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {company.clientName}
                  </Link>
                  {company.origin === 'inscription' && (
                    <span className="ml-1 text-xs text-muted-foreground">(fiche créée à l’inscription)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <section aria-labelledby="bannissement" className="flex flex-col gap-3">
        <h2 id="bannissement" className="text-sm font-semibold tracking-tight">
          {banned ? 'Réactiver le compte' : 'Bannir le compte'}
        </h2>
        <div className="rounded-lg border border-border bg-white px-5 py-4">
          {self ? (
            <p className="text-sm text-muted-foreground">C’est votre compte : vous ne pouvez pas le bannir.</p>
          ) : account.staffRole ? (
            <p className="text-sm text-muted-foreground">
              Ce compte est celui d’un membre de l’équipe. Pour lui fermer l’accès, retirez-le depuis{' '}
              <Link href="/equipe" className="text-primary underline underline-offset-2">
                l’écran Équipe
              </Link>
              .
            </p>
          ) : banned ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                La personne ne peut plus se connecter. Réactiver le compte lui rouvre la connexion
                immédiatement ; le bannissement reste dans l’historique.
              </p>
              <LiftButton ids={[account.id]} label="Réactiver le compte" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                La connexion en cours est coupée et toute nouvelle connexion refusée. Ses demandes et
                son historique restent.
              </p>
              <BanForm
                targets={[{ id: account.id, label: account.email }]}
                today={todayIsoDate(timeZone)}
                submitLabel="Bannir le compte"
              />
            </div>
          )}
        </div>
      </section>

      {!account.staffRole && (
        <section aria-labelledby="rattacher" className="flex flex-col gap-3">
          <h2 id="rattacher" className="text-sm font-semibold tracking-tight">
            Rattacher à une entreprise
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            La personne verra l’espace de cette entreprise — contrats, factures, courrier — dès sa
            prochaine page. Ne le faites que si elle en relève vraiment.
          </p>
          <div className="rounded-lg border border-border bg-white px-5 py-4">
            <AttachForm
              accountId={account.id}
              clients={clients
                .filter((client) => !linked.has(client.id))
                .map((client) => ({ id: client.id, name: client.name }))}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="historique" className="flex flex-col gap-3">
        <h2 id="historique" className="text-sm font-semibold tracking-tight">
          Historique des bannissements
        </h2>
        {account.bans.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ce compte n’a jamais été banni.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Banni le</th>
                  <th className="px-4 py-3 font-medium">Par</th>
                  <th className="px-4 py-3 font-medium">Motif</th>
                  <th className="px-4 py-3 font-medium">Durée</th>
                  <th className="px-4 py-3 font-medium">Fin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {account.bans.map((ban) => (
                  <tr key={ban.id}>
                    <td className="tabular px-4 py-3 align-top">{formatDateTime(ban.createdAt, timeZone)}</td>
                    <td className="px-4 py-3 align-top">{ban.bannedByName ?? '—'}</td>
                    <td className="px-4 py-3 align-top">{ban.reason}</td>
                    <td className="tabular px-4 py-3 align-top">
                      {ban.bannedUntil
                        ? `Jusqu’au ${formatCalendarDate(banLastDay(ban.bannedUntil, timeZone))} inclus`
                        : 'Jusqu’à levée'}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {ban.liftedAt
                        ? `Levé le ${formatDateTime(ban.liftedAt, timeZone)}${ban.liftedByName ? ` par ${ban.liftedByName}` : ''}`
                        : isBanActive(ban)
                          ? 'En cours'
                          : 'Arrivé à son terme'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
