import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { billingPeriodSuffixes } from '../../../../modules/contrats/labels.ts'
import { OfferRequestForm } from '../../../../modules/facturation/offer-request-form.tsx'
import { listPortalOffers, type PortalOffer } from '../../../../modules/facturation/offres-portail.ts'
import { formatQuantity } from '../../../../modules/facturation/services-labels.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Offres' }

/**
 * Offres groupées présentées dans l'espace client (R23, ADR 036) : ce que
 * chacune comprend, son prix par période calculé par le moteur de la vague 2
 * (`priceOffer`), ses conditions, et la demande en une action. La demande part
 * à l'accueil, qui établit le contrat : rien n'engage le client sans l'équipe.
 */
export default async function OffresPage() {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const offers = await listPortalOffers(accounts, todayIsoDate(tenant.timezone))
  const choices = accounts.map(({ clientId, clientName }) => ({ clientId, clientName }))

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Offres</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Des formules qui regroupent un espace et des services, à prix fixe par période. Demandez
          celle qui vous convient : l’accueil vous recontacte pour établir le contrat. Rien ne vous
          engage avant sa signature.
        </p>
      </div>

      {offers.length === 0 ? (
        <p className="max-w-prose rounded-lg border border-dashed border-border px-6 py-8 text-center text-muted-foreground">
          Le centre ne présente pas encore d’offre dans votre espace.
          {tenant.phone || tenant.email
            ? ` Pour un besoin régulier, contactez l’accueil${tenant.phone ? ` au ${tenant.phone}` : ''}${tenant.email ? `${tenant.phone ? ' ou' : ''} à ${tenant.email}` : ''}.`
            : ' Pour un besoin régulier, contactez l’accueil.'}
        </p>
      ) : (
        <ul className="grid max-w-5xl gap-6 lg:grid-cols-2">
          {offers.map((offer) => (
            <li key={offer.id}>
              <OfferCard offer={offer} accounts={choices} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OfferCard({
  offer,
  accounts,
}: {
  offer: PortalOffer
  accounts: { clientId: string; clientName: string }[]
}) {
  const { quote } = offer
  const per = billingPeriodSuffixes[offer.billingPeriod]
  const headingId = `offre-${offer.id}`
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col gap-4 rounded-lg border border-border bg-white p-4 sm:p-5"
    >
      <div>
        <h2 id={headingId} className="text-lg font-semibold text-primary">
          {offer.name}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {offer.commitmentMonths ? `Engagement de ${offer.commitmentMonths} mois` : 'Sans engagement'}
          {' · '}facturée {per}
        </p>
        {offer.description && (
          <p className="mt-2 whitespace-pre-line text-sm">{offer.description}</p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Ce que comprend l’offre {offer.name}, montants hors taxes {per}</caption>
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-3 font-medium">
                Compris
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                HT {per}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {quote.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2 pr-3 align-top">
                  <span className="block font-medium">{line.commercialLabel ?? line.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {line.kind === 'act'
                      ? `${line.includedActs} inclus ${per}${
                          line.extraActNetCents !== null
                            ? `, puis ${formatCents(line.extraActNetCents, quote.currency)} HT l’unité`
                            : ''
                        }`
                      : formatQuantity(line.quantity, line.unit)}
                  </span>
                </td>
                <td className="py-2 text-right align-top tabular">
                  {line.netAmountCents === null
                    ? 'À préciser'
                    : line.kind === 'act'
                      ? 'Inclus'
                      : formatCents(line.netAmountCents, quote.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {quote.complete ? (
        <dl className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Total HT {per}</dt>
            <dd className="tabular">{formatCents(quote.totalExclTaxCents, quote.currency)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 font-medium">
            <dt>Total TTC {per}</dt>
            <dd className="tabular">{formatCents(quote.totalInclTaxCents, quote.currency)}</dd>
          </div>
          {quote.savingsCents !== null && quote.savingsCents > 0 && (
            <div className="flex items-baseline justify-between gap-4 text-primary">
              <dt>Économie sur le prix catalogue</dt>
              <dd className="tabular">{formatCents(quote.savingsCents, quote.currency)} HT</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          Le prix de cette offre vous sera précisé par l’accueil.
        </p>
      )}

      <div className="mt-auto">
        <OfferRequestForm offerId={offer.id} headingId={headingId} accounts={accounts} />
      </div>
    </article>
  )
}
