import Link from 'next/link'

import { ErrorSummary } from '../../../components/ui/error-summary.tsx'
import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatIsoMonth, toIsoDate, todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'
import { formatPeriod, monthPoints, revenueKindLabels, revenueKindOrder } from '../../../modules/indicateurs/affichage.ts'
import { MonthlyColumnChart } from '../../../modules/indicateurs/graphique-mensuel.tsx'
import {
  dailyOccupancy,
  formatHours,
  formatRate,
  monthlyOccupancy,
  summarizeOccupancy,
} from '../../../modules/indicateurs/occupation.ts'
import {
  evolutionMonths,
  monthPeriod,
  parsePeriod,
  periodDays,
  periodFieldLabels,
  periodPresets,
  samePeriod,
  unionPeriod,
  type Period,
} from '../../../modules/indicateurs/periode.ts'
import { loadIndicatorData } from '../../../modules/indicateurs/queries.ts'
import {
  billingSummary,
  monthlyBilling,
  outstanding,
  revenueBreakdown,
  revenueByType,
  type RevenueAmounts,
} from '../../../modules/indicateurs/revenus.ts'
import { resourceIndicatorRows, totalRevenue, typeIndicatorRows } from '../../../modules/indicateurs/tableau.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'

export const metadata = { title: 'Indicateurs' }

type SearchParam = string | string[] | undefined

const periodHref = (period: Period) => `/indicateurs?du=${period.from}&au=${period.to}`

const percentTick = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 })

/**
 * Indicateurs du centre (R31) : occupation, chiffre d'affaires, encaissements,
 * revenu par ressource et par service, sur une période choisie, et l'évolution
 * des douze derniers mois.
 *
 * Tous les chiffres viennent des fonctions pures d'`indicateurs/` (taux,
 * agrégats de revenus, avoirs), éprouvées sur des jeux construits ; la page ne
 * calcule rien elle-même. Réservée à l'exploitant (`indicateurs.consulter`,
 * ADR 019 et 027).
 */
export default async function IndicateursPage({
  searchParams,
}: {
  searchParams: Promise<{ du?: SearchParam; au?: SearchParam }>
}) {
  const { member } = await requirePermission('indicateurs.consulter')
  const params = await searchParams
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const currency = tenant.currency.trim()
  const today = todayIsoDate(timeZone)

  const { period, input, errors } = parsePeriod(params, today)
  const months = evolutionMonths(period)
  const evolution = { from: `${months[0]}-01`, to: monthPeriod(months[months.length - 1]).to }
  const range = unionPeriod(period, evolution)

  const data = await loadIndicatorData({ period, range, timeZone })

  const daily = dailyOccupancy({
    // Une ressource n'est ouverte qu'entre sa déclaration et son archivage.
    resources: data.resources.map((resource) => ({
      id: resource.id,
      firstDay: toIsoDate(resource.createdAt, timeZone),
      lastDay: resource.deletedAt ? toIsoDate(resource.deletedAt, timeZone) : null,
    })),
    days: periodDays(range),
    bookings: data.bookings,
    rules: data.rules,
    closures: data.closures,
    timeZone,
  })
  const occupancy = summarizeOccupancy(daily, data.resources, period)
  const occupancyByMonth = monthlyOccupancy(daily, data.resources, months)

  const revenue = revenueBreakdown(data.lines, currency, data.creditedLines)
  const resourceTypeOf = new Map(data.resources.map((resource) => [resource.id, resource.resourceType]))
  const { byType: revenueTypes, unknown: revenueUnknownResource } = revenueByType(revenue.byResource, (id) =>
    resourceTypeOf.get(id),
  )
  const typeRows = typeIndicatorRows(occupancy.types, revenueTypes)
  const resourceRows = resourceIndicatorRows(data.resources, occupancy, revenue.byResource)
  const resourcesRevenue = totalRevenue(resourceRows)

  const billing = billingSummary({ documents: data.documents, payments: data.payments, currency, period, today })
  const encours = outstanding(data.outstanding, currency, today)
  const billingByMonth = monthlyBilling({ documents: data.documents, payments: data.payments, currency, months })

  const servicesById = new Map(data.services.map((service) => [service.id, service]))
  const serviceRows = [...revenue.byService.entries()]
    .map(([id, amounts]) => ({ id, service: servicesById.get(id), ...amounts }))
    .sort((a, b) => b.netCents - a.netCents || (a.service?.name ?? '').localeCompare(b.service?.name ?? ''))
  const kindRows = revenueKindOrder
    .filter((kind) => revenue.byKind.has(kind))
    .map((kind) => ({ kind, ...revenue.byKind.get(kind)! }))

  const money = (cents: number) => formatCents(cents, currency)
  const moneyTick = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  const otherCurrency = revenue.otherCurrencyLines + billing.otherCurrencyCount
  const canManageResources = can(member.role, 'ressources.gerer')
  const hasErrors = Object.keys(errors).length > 0

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Indicateurs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Période {formatPeriod(period)}. Jours et heures du centre ({timeZone}), montants en{' '}
          {currency}.
        </p>
      </div>

      <section aria-labelledby="periode-titre" className="flex flex-col gap-3">
        <h2 id="periode-titre" className="sr-only">
          Choisir la période
        </h2>
        <ul className="flex flex-wrap gap-2">
          {periodPresets(today).map((preset) => {
            const active = !hasErrors && samePeriod(preset.period, period)
            return (
              <li key={preset.label}>
                <Link
                  href={periodHref(preset.period)}
                  aria-current={active ? 'true' : undefined}
                  className={`inline-block rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-white text-foreground hover:bg-muted'
                  }`}
                >
                  {preset.label}
                </Link>
              </li>
            )
          })}
        </ul>

        {hasErrors && (
          <ErrorSummary
            errors={errors}
            labels={periodFieldLabels}
            message="Période non reconnue : les chiffres ci-dessous sont ceux du mois en cours."
          />
        )}

        {/* Formulaire GET : la période reste dans l'adresse, l'écran se partage. */}
        <form className="flex flex-wrap items-end gap-3" noValidate>
          {(['du', 'au'] as const).map((field) => (
            <div key={field} className="flex flex-col">
              <label htmlFor={field} className="text-xs font-medium text-muted-foreground">
                {periodFieldLabels[field]}
              </label>
              <input
                id={field}
                name={field}
                type="date"
                defaultValue={input[field]}
                aria-invalid={errors[field] ? true : undefined}
                aria-describedby={errors[field] ? `${field}-error` : undefined}
                className="mt-1 rounded-sm border border-input bg-white px-3 py-1.5 text-sm tabular focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {errors[field] && (
                <p id={`${field}-error`} role="alert" className="mt-1 text-xs text-destructive">
                  {periodFieldLabels[field]} : {errors[field]}
                </p>
              )}
            </div>
          ))}
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Afficher
          </button>
        </form>
      </section>

      <section aria-labelledby="synthese-titre" className="flex flex-col gap-3">
        <h2 id="synthese-titre" className="text-lg font-semibold tracking-tight">
          Synthèse
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Chiffre d’affaires facturé"
            value={`${money(billing.invoicedExclTaxCents)} HT`}
            detail={`${money(billing.invoicedInclTaxCents)} TTC · ${plural(billing.invoiceCount, 'facture', 'factures')}, ${plural(billing.creditNoteCount, 'avoir', 'avoirs')} (${money(billing.creditNotesExclTaxCents)} HT déduits)`}
          />
          <Tile
            label="Encaissé"
            value={money(billing.collectedCents)}
            detail="Paiements reçus sur la période, remboursements déduits"
          />
          <Tile
            label="Restant dû"
            value={money(billing.dueCents)}
            detail={`Sur les factures de la période, à ce jour, dont ${money(billing.overdueCents)} échus`}
          />
          <Tile
            label="Taux d’occupation"
            value={formatRate(occupancy.total.rate)}
            detail={`${formatHours(occupancy.total.busyMinutes)} occupées sur ${formatHours(occupancy.total.openMinutes)} d’ouverture`}
          />
        </dl>
        <p className="text-sm text-muted-foreground">
          Encours clients à ce jour, toutes périodes confondues :{' '}
          <span className="font-medium text-foreground tabular">{money(encours.dueCents)}</span> sur{' '}
          {plural(encours.invoiceCount, 'facture', 'factures')}, dont{' '}
          <span className="font-medium text-foreground tabular">{money(encours.overdueCents)}</span> échus.
        </p>
        {otherCurrency > 0 && (
          <p className="text-sm text-muted-foreground">
            {plural(otherCurrency, 'ligne, facture ou paiement', 'lignes, factures ou paiements')} dans une autre
            devise que {currency} ne {otherCurrency > 1 ? 'sont' : 'est'} pas compté
            {otherCurrency > 1 ? 's' : ''} : les montants ne se convertissent pas.
          </p>
        )}
      </section>

      <section aria-labelledby="types-titre" className="flex flex-col gap-3">
        <h2 id="types-titre" className="text-lg font-semibold tracking-tight">
          Occupation et revenu par type de ressource
        </h2>
        {typeRows.length === 0 ? (
          <EmptyState>
            <p>Aucune ressource dans le parc : le taux d’occupation se calcule dès qu’une ressource est déclarée.</p>
            {canManageResources && (
              <Link
                href="/ressources/nouvelle"
                className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
              >
                Déclarer une ressource
              </Link>
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Occupation et revenu net par type de ressource, {formatPeriod(period)}
              </caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Type</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Ressources</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Ouverture</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Occupé</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Dont contrats</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Taux</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Revenu net HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {typeRows.map((row) => (
                  <tr key={row.resourceType}>
                    <th scope="row" className="px-4 py-2 font-medium">
                      {resourceTypeLabels[row.resourceType]}
                    </th>
                    <td className="px-4 py-2 text-right tabular">{row.occupancy?.resourceCount ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular">
                      {row.occupancy ? formatHours(row.occupancy.openMinutes) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {row.occupancy ? formatHours(row.occupancy.busyMinutes) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular">
                      {row.occupancy ? formatHours(row.occupancy.contractMinutes) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Rate rate={row.occupancy?.rate ?? null} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular">{money(row.revenue.netCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border font-medium">
                <tr>
                  <th scope="row" className="px-4 py-2">
                    Tout le parc
                  </th>
                  <td className="px-4 py-2 text-right tabular">{occupancy.resources.length}</td>
                  <td className="px-4 py-2 text-right tabular">{formatHours(occupancy.total.openMinutes)}</td>
                  <td className="px-4 py-2 text-right tabular">{formatHours(occupancy.total.busyMinutes)}</td>
                  <td className="px-4 py-2 text-right tabular">{formatHours(occupancy.total.contractMinutes)}</td>
                  <td className="px-4 py-2 text-right">
                    <Rate rate={occupancy.total.rate} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular">
                    {money(resourcesRevenue.netCents + revenueUnknownResource.netCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {resourceRows.length > 0 && (
        <section aria-labelledby="ressources-titre" className="flex flex-col gap-3">
          <h2 id="ressources-titre" className="text-lg font-semibold tracking-tight">
            Par ressource
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Occupation, facturé, avoirs et revenu net par ressource, {formatPeriod(period)}
              </caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
                  <th scope="col" className="px-4 py-3 font-medium">Type</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Ouverture</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Occupé</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Jours sous contrat</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Taux</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Facturé HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Avoirs HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Revenu net HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {resourceRows.map(({ resource, occupancy: row, revenue: amounts }) => (
                  <tr key={resource.id}>
                    <th scope="row" className="px-4 py-2 font-normal">
                      {canManageResources ? (
                        <Link href={`/ressources/${resource.id}`} className="underline-offset-2 hover:underline">
                          <span className="tabular">{resource.code}</span> — {resource.name}
                        </Link>
                      ) : (
                        <>
                          <span className="tabular">{resource.code}</span> — {resource.name}
                        </>
                      )}
                      {(resource.deletedAt || resource.status === 'retired') && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({resource.deletedAt ? 'archivée' : 'retirée du parc'})
                        </span>
                      )}
                    </th>
                    <td className="px-4 py-2 text-muted-foreground">{resourceTypeLabels[resource.resourceType]}</td>
                    <td className="px-4 py-2 text-right tabular">{row ? formatHours(row.openMinutes) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular">{row ? formatHours(row.busyMinutes) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular">{row ? row.contractDays : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <Rate rate={row?.rate ?? null} />
                    </td>
                    <Amounts amounts={amounts} money={money} />
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border font-medium">
                <tr>
                  <th scope="row" colSpan={6} className="px-4 py-2">
                    Total des ressources
                  </th>
                  <Amounts amounts={resourcesRevenue} money={money} />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="services-titre" className="flex flex-col gap-3">
        <h2 id="services-titre" className="text-lg font-semibold tracking-tight">
          Services et actes
        </h2>
        {serviceRows.length === 0 ? (
          <EmptyState>
            <p>
              Aucun forfait ni acte facturé {formatPeriod(period)}. Ils apparaissent ici dès l’émission d’une
              facture qui les porte ; choisissez une autre période pour voir les précédentes.
            </p>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Revenu et nombre d’actes par service, {formatPeriod(period)}</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Service</th>
                  <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Actes facturés</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Dont inclus</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Facturé HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Avoirs HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Revenu net HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {serviceRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="px-4 py-2 font-normal">
                      {row.service?.name ?? 'Service inconnu'}
                      {row.service?.deletedAt && (
                        <span className="ml-2 text-xs text-muted-foreground">(archivé)</span>
                      )}
                    </th>
                    <td className="px-4 py-2 text-muted-foreground">
                      {row.service?.nature === 'act' ? 'Acte' : row.service?.nature === 'package' ? 'Forfait' : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{row.service?.nature === 'act' ? row.acts : '—'}</td>
                    <td className="px-4 py-2 text-right tabular">
                      {row.service?.nature === 'act' ? row.includedActs : '—'}
                    </td>
                    <Amounts amounts={row} money={money} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {revenue.withoutResource.netCents !== 0 && (
          <p className="text-sm text-muted-foreground">
            Revenu sans ressource (services, actes, remises, lignes libres) :{' '}
            <span className="font-medium text-foreground tabular">{money(revenue.withoutResource.netCents)}</span> HT
            net.
          </p>
        )}
      </section>

      <section aria-labelledby="natures-titre" className="flex flex-col gap-3">
        <h2 id="natures-titre" className="text-lg font-semibold tracking-tight">
          Chiffre d’affaires par nature
        </h2>
        {kindRows.length === 0 ? (
          <EmptyState>
            <p>
              Aucune facture émise {formatPeriod(period)}. Le chiffre d’affaires apparaît à l’émission des
              factures ; un brouillon n’en fait pas encore partie.
            </p>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Chiffre d’affaires par nature de ligne, {formatPeriod(period)}</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Facturé HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Avoirs HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Net HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {kindRows.map((row) => (
                  <tr key={row.kind}>
                    <th scope="row" className="px-4 py-2 font-normal">
                      {revenueKindLabels[row.kind]}
                    </th>
                    <Amounts amounts={row} money={money} />
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border font-medium">
                <tr>
                  <th scope="row" className="px-4 py-2">
                    Total
                  </th>
                  <Amounts amounts={revenue.total} money={money} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="evolution-titre" className="flex flex-col gap-4">
        <h2 id="evolution-titre" className="text-lg font-semibold tracking-tight">
          Évolution sur douze mois
        </h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <MonthlyColumnChart
            id="graphique-ca"
            title={`Chiffre d’affaires facturé HT, avoirs déduits (${currency})`}
            summary={`Histogramme de ${formatIsoMonth(months[0])} à ${formatIsoMonth(months[months.length - 1])}. Chaque valeur figure dans le tableau « Évolution mois par mois » qui suit.`}
            points={monthPoints(
              billingByMonth.map((row) => ({ month: row.month, value: row.invoicedExclTaxCents })),
              money,
            )}
            formatTick={(cents) => moneyTick.format(cents / 100)}
          />
          <MonthlyColumnChart
            id="graphique-occupation"
            title="Taux d’occupation de tout le parc"
            summary={`Histogramme de ${formatIsoMonth(months[0])} à ${formatIsoMonth(months[months.length - 1])}, de 0 à 100 %. Chaque valeur figure dans le tableau « Évolution mois par mois » qui suit.`}
            points={monthPoints(
              occupancyByMonth.map((row) => ({ month: row.month, value: row.rate ?? 0 })),
              (value) => formatRate(value),
            )}
            formatTick={(tenths) => percentTick.format(tenths / 1000)}
            minMax={1000}
          />
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="px-4 pt-3 text-left text-sm font-medium">Évolution mois par mois</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Mois</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Facturé HT</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Facturé TTC</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Encaissé</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Taux d’occupation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {billingByMonth.map((row, index) => (
                <tr key={row.month}>
                  <th scope="row" className="px-4 py-2 font-normal capitalize">
                    {formatIsoMonth(row.month)}
                  </th>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular">{money(row.invoicedExclTaxCents)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular">{money(row.invoicedInclTaxCents)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular">{money(row.collectedCents)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular">
                    {formatRate(occupancyByMonth[index]?.rate ?? null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="definitions-titre" className="flex max-w-3xl flex-col gap-2 text-sm">
        <h2 id="definitions-titre" className="text-lg font-semibold tracking-tight">
          Comment ces chiffres sont calculés
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">Taux d’occupation</strong> : heures occupées sur heures
            d’ouverture de chaque ressource, jour par jour, selon ses horaires et ses fermetures. Comptent les
            réservations confirmées et les contrats — une ressource sous contrat est occupée toutes ses heures
            d’ouverture, chaque jour du contrat. Ne comptent ni les demandes en attente, ni les indisponibilités,
            ni ce qui déborde des horaires. Une ressource n’est comptée ouverte qu’à partir de sa déclaration et
            jusqu’à son archivage. Un type se calcule sur la somme de ses heures.
          </li>
          <li>
            <strong className="font-medium text-foreground">Chiffre d’affaires</strong> : factures émises sur la
            période, à leur date d’émission, moins les avoirs émis sur la même période. Un brouillon ne compte
            pas. Un avoir est retiré de la ressource et du service de la ligne qu’il crédite.
          </li>
          <li>
            <strong className="font-medium text-foreground">Encaissé</strong> : paiements pointés à leur date de
            valeur, annulations exclues, remboursements déduits.{' '}
            <strong className="font-medium text-foreground">Restant dû</strong> : ce qui manque aujourd’hui sur les
            factures émises dans la période, avoirs et paiements déduits ; un trop-perçu ne vient pas en
            déduction.
          </li>
          <li>
            <strong className="font-medium text-foreground">Actes</strong> : ouvertures de courrier et autres actes
            portés sur les factures, y compris ceux inclus dans une souscription et facturés 0 €, moins ceux
            crédités par avoir.
          </li>
          <li>
            Les « heures administratives économisées » du cahier des charges ne sont pas mesurables par
            l’application : elle ne connaît pas le temps que prenaient les tâches avant elle. Les estimer demande
            un relevé du temps passé, avant et après, tenu par l’équipe.
          </li>
          <li>
            La rentabilité d’un service ou d’une ressource rapporte le revenu à son coût ; les coûts ne sont pas
            saisis dans l’application, seul le revenu est montré.
          </li>
        </ul>
      </section>
    </div>
  )
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-white px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight tabular">{value}</dd>
      <dd className="text-xs text-muted-foreground">{detail}</dd>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Taux en texte, redoublé d'une jauge discrète pour parcourir la colonne d'un
 * coup d'œil. La jauge est décorative : le nombre dit tout, et la teinte est la
 * même quel que soit le taux — un taux bas n'est pas une erreur.
 */
function Rate({ rate }: { rate: number | null }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tabular">{formatRate(rate)}</span>
      {rate !== null && (
        <span aria-hidden="true" className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-border sm:inline-block">
          <span className="block h-full rounded-full bg-brand-fonce" style={{ width: `${rate / 10}%` }} />
        </span>
      )}
    </span>
  )
}

function Amounts({ amounts, money }: { amounts: RevenueAmounts; money: (cents: number) => string }) {
  return (
    <>
      <td className="whitespace-nowrap px-4 py-2 text-right tabular">{money(amounts.invoicedCents)}</td>
      <td className="whitespace-nowrap px-4 py-2 text-right tabular">
        {amounts.creditedCents === 0 ? '—' : money(-amounts.creditedCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular">{money(amounts.netCents)}</td>
    </>
  )
}
