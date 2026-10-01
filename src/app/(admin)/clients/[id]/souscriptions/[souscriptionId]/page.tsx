import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../../lib/tenant.ts'
import { rateUnitSuffixes } from '../../../../../../modules/facturation/labels.ts'
import {
  bpToPercentInput,
  centsToAmountInput,
  formatBp,
  formatCalendarDay,
  shiftIsoDate,
} from '../../../../../../modules/facturation/saisie.ts'
import { serviceNatureLabels } from '../../../../../../modules/facturation/services-labels.ts'
import { findSubscription } from '../../../../../../modules/facturation/souscriptions-queries.ts'
import {
  subscriptionState,
  subscriptionStateLabels,
  subscriptionStateStyles,
} from '../../../../../../modules/facturation/souscriptions-regles.ts'
import {
  SubscriptionCancelButton,
  SubscriptionEndForm,
} from '../../../../../../modules/facturation/subscription-end-form.tsx'
import { SubscriptionForm } from '../../../../../../modules/facturation/subscription-form.tsx'
import { formatCents } from '../../../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Souscription' }

/** Le plus tardif de deux jours ISO. */
const latest = (a: string, b: string) => (a > b ? a : b)

/**
 * Une souscription et ce qu'on peut en faire (R18) : changer ses conditions à
 * une date d'effet, fixer sa fin, ou l'annuler si rien n'a été facturé.
 * Jamais de suppression, ni de réécriture d'un prix convenu (ADR 024).
 */
export default async function SubscriptionPage({
  params,
}: {
  params: Promise<{ id: string; souscriptionId: string }>
}) {
  await requirePermission('souscriptions.gerer')
  const [{ id, souscriptionId }, tenant] = await Promise.all([params, currentTenant()])
  const subscription = await findSubscription(souscriptionId)
  if (!subscription || subscription.clientId !== id) notFound()

  const today = todayIsoDate(tenant.timezone)
  const state = subscriptionState(subscription, today)
  const isAct = subscription.service.nature === 'act'
  const { billedThrough } = subscription
  // Premier jour où de nouvelles conditions peuvent s'appliquer : ni avant le
  // début, ni sur un jour déjà facturé ; aujourd'hui par défaut.
  const earliestChange = billedThrough
    ? latest(subscription.startsOn, shiftIsoDate(billedThrough, 1))
    : subscription.startsOn
  const changeDefault = latest(earliestChange, today)
  const canChange =
    !subscription.deletedAt &&
    !subscription.client.archived &&
    (subscription.endsOn === null || earliestChange <= subscription.endsOn)
  const earliestEnd = billedThrough ? latest(subscription.startsOn, billedThrough) : subscription.startsOn

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/clients/${subscription.clientId}#services`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {subscription.client.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{subscription.service.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${subscriptionStateStyles[state]}`}
          >
            {subscriptionStateLabels[state]}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[12rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Nature</dt>
        <dd>{serviceNatureLabels[subscription.service.nature]}</dd>

        <dt className="text-muted-foreground">Contrat</dt>
        <dd>
          {subscription.contract ? (
            <Link
              href={`/contrats/${subscription.contract.id}`}
              className="underline-offset-2 hover:underline"
            >
              {subscription.contract.reference}
            </Link>
          ) : (
            'Hors contrat'
          )}
        </dd>

        {isAct ? (
          <>
            <dt className="text-muted-foreground">Actes inclus</dt>
            <dd className="tabular">{subscription.includedQuantity ?? 0} par mois</dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">Quantité</dt>
            <dd className="tabular">{subscription.quantity}</dd>
          </>
        )}

        <dt className="text-muted-foreground">Prix HT figé</dt>
        <dd className="tabular">
          {formatCents(subscription.unitPriceCents, subscription.currency)}{' '}
          {isAct ? 'l’acte au-delà des inclus' : rateUnitSuffixes[subscription.unit]}
          {subscription.discountBp !== null && ` · remise ${formatBp(subscription.discountBp)}`}
          {subscription.discountAmountCents !== null &&
            ` · remise ${formatCents(subscription.discountAmountCents, subscription.currency)} par période`}
        </dd>

        {!isAct && (
          <>
            <dt className="text-muted-foreground">Montant HT par période</dt>
            <dd className="tabular">
              {formatCents(subscription.netAmountCents ?? 0, subscription.currency)}
            </dd>
          </>
        )}

        <dt className="text-muted-foreground">TVA</dt>
        <dd className="tabular">{formatBp(subscription.vatRateBp)}</dd>

        <dt className="text-muted-foreground">Période</dt>
        <dd className="tabular">
          du {formatCalendarDay(subscription.startsOn)}{' '}
          {subscription.endsOn ? `au ${formatCalendarDay(subscription.endsOn)}` : 'sans date de fin'}
        </dd>

        <dt className="text-muted-foreground">Facturation</dt>
        <dd>
          {billedThrough
            ? `Facturée jusqu’au ${formatCalendarDay(billedThrough)}`
            : subscription.billedLineCount > 0
              ? 'Déjà portée sur une facture'
              : 'Pas encore facturée'}
        </dd>

        {subscription.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{subscription.notes}</dd>
          </>
        )}
      </dl>

      {subscription.deletedAt ? (
        <p className="rounded-lg border border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Souscription annulée : elle reste dans l’historique du client et ne change plus.
        </p>
      ) : subscription.client.archived ? (
        <p className="rounded-lg border border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          La fiche client est archivée : ses souscriptions ne changent plus.
        </p>
      ) : (
        <>
          <section aria-labelledby="conditions-titre" className="flex flex-col gap-3">
            <h2 id="conditions-titre" className="text-sm font-semibold tracking-tight">
              Changer la quantité ou le prix
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Un prix convenu ne se réécrit pas : la souscription prend fin la veille de la date
              d’effet, et une nouvelle la suit aux nouvelles conditions. Les deux restent dans
              l’historique.
            </p>
            {canChange ? (
              <SubscriptionForm
                mode="change"
                clientId={subscription.clientId}
                subscription={{ id: subscription.id }}
                services={[
                  {
                    id: subscription.service.id,
                    name: subscription.service.name,
                    nature: subscription.service.nature,
                    unit: subscription.unit,
                    unitPriceCents: subscription.unitPriceCents,
                    vatRateBp: subscription.vatRateBp,
                    currency: subscription.currency,
                  },
                ]}
                defaults={{
                  serviceId: subscription.service.id,
                  contractId: subscription.contractId ?? '',
                  quantity: String(subscription.quantity),
                  unitPrice: centsToAmountInput(subscription.unitPriceCents),
                  discountKind:
                    subscription.discountBp !== null
                      ? 'percent'
                      : subscription.discountAmountCents !== null
                        ? 'amount'
                        : 'none',
                  discountPercent:
                    subscription.discountBp !== null ? bpToPercentInput(subscription.discountBp) : '',
                  discountAmount:
                    subscription.discountAmountCents !== null
                      ? centsToAmountInput(subscription.discountAmountCents)
                      : '',
                  vatRate: bpToPercentInput(subscription.vatRateBp),
                  includedQuantity: String(subscription.includedQuantity ?? 0),
                  startsOn: subscription.startsOn,
                  endsOn: subscription.endsOn ?? '',
                  effectiveOn: changeDefault,
                  notes: subscription.notes ?? '',
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Facturée jusqu’à son dernier jour : souscrivez à nouveau depuis la fiche client.
              </p>
            )}
          </section>

          <section
            aria-labelledby="fin-titre"
            className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
          >
            <h2 id="fin-titre" className="text-sm font-semibold tracking-tight">
              Mettre fin à la souscription
            </h2>
            <SubscriptionEndForm
              id={subscription.id}
              endsOn={subscription.endsOn}
              hint={`Au plus tôt le ${formatCalendarDay(earliestEnd)}${billedThrough ? ', dernier jour déjà facturé' : ', premier jour'}. Vide : sans date de fin.`}
            />
          </section>

          {subscription.billedLineCount === 0 && (
            <section
              aria-labelledby="annuler-titre"
              className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
            >
              <h2 id="annuler-titre" className="text-sm font-semibold tracking-tight">
                Saisie par erreur ?
              </h2>
              <p className="text-sm text-muted-foreground">
                Rien n’a encore été facturé à son titre : elle peut être annulée. Elle reste
                visible dans l’historique.
              </p>
              <div>
                <SubscriptionCancelButton id={subscription.id} label={subscription.service.name} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
