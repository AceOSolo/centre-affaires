import Link from 'next/link'

import { todayIsoDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { SuccessNotice } from './champs.tsx'
import { rateUnitSuffixes } from './labels.ts'
import { formatBp, formatCalendarDay } from './saisie.ts'
import { serviceNatureLabels } from './services-labels.ts'
import {
  findMailOpeningUsage,
  listClientSubscriptions,
  type IncludedUsage,
  type SubscriptionRow,
} from './souscriptions-queries.ts'
import {
  isCurrent,
  subscriptionHold,
  subscriptionHoldHints,
  subscriptionHoldLabels,
  subscriptionState,
  subscriptionStateLabels,
  subscriptionStateStyles,
} from './souscriptions-regles.ts'
import { formatCents } from './tarifs.ts'

/** Confirmations après écriture. Une `Map` : `?souscription=constructor` ne trouve rien. */
const notices = new Map([
  ['ajoutee', 'Souscription enregistrée, à son prix figé.'],
  ['modifiee', 'Nouvelles conditions enregistrées : la souscription précédente prend fin la veille.'],
  ['terminee', 'Date de fin enregistrée.'],
  ['prolongee', 'Souscription prolongée, sans date de fin.'],
  ['annulee', 'Souscription annulée.'],
])

/**
 * Services souscrits d'un client, sur sa fiche (R07, R18) : en cours et à
 * venir, puis l'historique — terminées et annulées. Chaque changement de prix
 * est une ligne : l'historique des conditions se lit de haut en bas.
 *
 * Composant serveur : il charge ses propres données, la fiche n'a qu'à le
 * placer.
 */
export async function ClientSubscriptionsSection({
  clientId,
  archivedClient,
  canManage,
  notice,
}: {
  clientId: string
  archivedClient: boolean
  /** Droit `souscriptions.gerer` : souscrire, changer, mettre fin. */
  canManage: boolean
  /** Clé de `?souscription=` après une écriture. */
  notice?: string
}) {
  const tenant = await currentTenant()
  const today = todayIsoDate(tenant.timezone)
  const [subscriptions, usage] = await Promise.all([
    listClientSubscriptions(clientId),
    findMailOpeningUsage(clientId, today, tenant.timezone),
  ])
  const current = subscriptions.filter((row) => isCurrent(subscriptionState(row, today)))
  const history = subscriptions.filter((row) => !isCurrent(subscriptionState(row, today)))
  const message = notice ? notices.get(notice) : undefined
  const canSubscribe = canManage && !archivedClient

  return (
    <section id="services" aria-labelledby="services-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="services-titre" className="text-sm font-semibold tracking-tight">
          Services souscrits{' '}
          <span className="font-normal text-muted-foreground">({current.length})</span>
        </h2>
        {canSubscribe && (
          <Link
            href={`/clients/${clientId}/souscriptions/nouvelle`}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Souscrire un service
          </Link>
        )}
      </div>

      {message && <SuccessNotice>{message}</SuccessNotice>}

      {current.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Aucun service en cours : forfaits (standard, assistante) et actes (numérisation du
          courrier) se souscrivent ici, à un prix figé.
          {canSubscribe && (
            <>
              {' '}
              <Link
                href={`/clients/${clientId}/souscriptions/nouvelle`}
                className="font-medium text-primary underline underline-offset-2"
              >
                Souscrire un service
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <SubscriptionTable
          id="services-en-cours"
          caption="Services en cours et à venir"
          rows={current}
          today={today}
          usage={usage}
          clientId={clientId}
          canManage={canManage && !archivedClient}
        />
      )}

      {history.length > 0 && (
        <details className="rounded-lg border border-border bg-white">
          <summary className="cursor-pointer rounded-lg px-5 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Historique des souscriptions{' '}
            <span className="font-normal text-muted-foreground">({history.length})</span>
          </summary>
          <div className="border-t border-border">
            <SubscriptionTable
              id="services-historique"
              caption="Souscriptions terminées et annulées"
              rows={history}
              today={today}
              usage={usage}
              clientId={clientId}
              canManage={false}
              flat
            />
          </div>
        </details>
      )}
    </section>
  )
}

function SubscriptionTable({
  id,
  caption,
  rows,
  today,
  usage,
  clientId,
  canManage,
  flat = false,
}: {
  id: string
  caption: string
  rows: SubscriptionRow[]
  today: string
  usage: Map<string, IncludedUsage>
  clientId: string
  canManage: boolean
  /** Sans bordure propre, dans un conteneur qui en a une. */
  flat?: boolean
}) {
  return (
    <div className={`overflow-x-auto ${flat ? '' : 'rounded-lg border border-border'} bg-white`}>
      <table id={id} className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Service</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Quantité</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Prix HT figé</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
            <th scope="col" className="px-4 py-3 font-medium">Période</th>
            <th scope="col" className="px-4 py-3 font-medium">État</th>
            {canManage && (
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const state = subscriptionState(row, today)
            // Un contrat brouillon ou archivé retient la facturation (ADR 035).
            const hold = isCurrent(state) ? subscriptionHold(row.contract) : null
            const isAct = row.service.nature === 'act'
            const used = usage.get(row.id)
            return (
              <tr key={row.id}>
                <td className="px-4 py-3">
                  <span className="font-medium">{row.service.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {serviceNatureLabels[row.service.nature]}
                    {row.contract ? (
                      <>
                        {' · contrat '}
                        <Link
                          href={`/contrats/${row.contract.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {row.contract.reference}
                        </Link>
                        {hold && ` (${subscriptionHoldHints[hold]})`}
                      </>
                    ) : (
                      ' · hors contrat'
                    )}
                  </span>
                  {row.notes && (
                    <span className="block max-w-prose text-xs text-muted-foreground">{row.notes}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {isAct ? (
                    <>
                      {row.includedQuantity ?? 0} inclus
                      <span className="block text-xs text-muted-foreground">par mois</span>
                      {used && state === 'active' && (
                        <span className="block text-xs text-muted-foreground">
                          ce mois-ci : {used.included} inclus
                          {used.beyond > 0 ? `, ${used.beyond} au-delà` : ''}
                        </span>
                      )}
                    </>
                  ) : (
                    row.quantity
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {formatCents(row.unitPriceCents, row.currency)}
                  <span className="block text-xs text-muted-foreground">
                    {isAct ? 'l’acte au-delà des inclus' : rateUnitSuffixes[row.unit]}
                    {row.discountBp !== null && ` · remise ${formatBp(row.discountBp)}`}
                    {row.discountAmountCents !== null &&
                      ` · remise ${formatCents(row.discountAmountCents, row.currency)}`}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {isAct ? (
                    <span className="text-muted-foreground">À l’acte</span>
                  ) : (
                    formatCents(row.netAmountCents ?? 0, row.currency)
                  )}
                  <span className="block text-xs text-muted-foreground">
                    TVA {formatBp(row.vatRateBp)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                  {formatCalendarDay(row.startsOn)} →{' '}
                  {row.endsOn ? formatCalendarDay(row.endsOn) : 'sans fin'}
                </td>
                <td className="px-4 py-3">
                  {/* L'état se lit au libellé ; la teinte l'accompagne (ADR 004). */}
                  <span
                    className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${hold ? subscriptionStateStyles.ended : subscriptionStateStyles[state]}`}
                  >
                    {hold ? subscriptionHoldLabels[hold] : subscriptionStateLabels[state]}
                  </span>
                </td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/clients/${clientId}/souscriptions/${row.id}`}
                      aria-label={`Gérer la souscription ${row.service.name}`}
                      className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                    >
                      Gérer
                    </Link>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
