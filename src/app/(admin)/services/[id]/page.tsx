import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { SuccessNotice, dangerButtonClass } from '../../../../modules/facturation/champs.tsx'
import { rateUnitLabels } from '../../../../modules/facturation/labels.ts'
import {
  bpToPercentInput,
  centsToAmountInput,
  formatBp,
} from '../../../../modules/facturation/saisie.ts'
import { ServiceForm } from '../../../../modules/facturation/service-form.tsx'
import { archiveServiceAction } from '../../../../modules/facturation/services-actions.ts'
import {
  serviceNatureLabels,
  serviceState,
  serviceStateLabels,
  serviceStateStyles,
} from '../../../../modules/facturation/services-labels.ts'
import { findService, findServiceUsage } from '../../../../modules/facturation/services-queries.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Service' }

/** Confirmations après écriture. Une `Map` : `?enregistre=constructor` ne trouve rien. */
const notices = new Map([
  ['cree', 'Service créé.'],
  ['modifie', 'Service enregistré.'],
  ['archive', 'Service archivé.'],
])

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ enregistre?: string }>
}) {
  await requirePermission('services.gerer')
  const [{ id }, { enregistre }, tenant] = await Promise.all([params, searchParams, currentTenant()])
  const service = await findService(id)
  if (!service) notFound()

  const usage = await findServiceUsage(service.id, todayIsoDate(tenant.timezone))
  const state = serviceState(service)
  const notice = typeof enregistre === 'string' ? notices.get(enregistre) : undefined

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/services" className="text-sm text-muted-foreground hover:underline">
          ← Services
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{service.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${serviceStateStyles[state]}`}
          >
            {serviceStateLabels[state]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {serviceNatureLabels[service.nature]} · {rateUnitLabels[service.unit].toLowerCase()} ·{' '}
          <span className="tabular">{formatCents(service.unitPriceCents, service.currency)}</span>{' '}
          HT · TVA {formatBp(service.vatRateBp)}
          {service.code && <> · code {service.code}</>}
        </p>
      </div>

      {notice && <SuccessNotice>{notice}</SuccessNotice>}

      <p className="text-sm text-muted-foreground">
        {usage.currentSubscriptions === 0
          ? 'Aucune souscription en cours.'
          : `${usage.currentSubscriptions} souscription${usage.currentSubscriptions > 1 ? 's' : ''} en cours ou à venir, à leur prix figé.`}{' '}
        {usage.activeOffers === 0
          ? 'Aucune offre active ne le propose.'
          : `Proposé dans ${usage.activeOffers} offre${usage.activeOffers > 1 ? 's' : ''} active${usage.activeOffers > 1 ? 's' : ''}.`}
      </p>

      {service.deletedAt ? (
        <p className="rounded-lg border border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Service archivé : il est sorti du catalogue et ne se modifie plus. Les souscriptions et les
          factures qui le citent restent lisibles.
        </p>
      ) : (
        <>
          <section aria-labelledby="modifier-titre" className="flex flex-col gap-3">
            <h2 id="modifier-titre" className="text-sm font-semibold tracking-tight">
              Modifier
            </h2>
            <ServiceForm
              id={service.id}
              lockedCode={service.code !== null}
              lockedNature
              defaults={{
                code: service.code ?? '',
                name: service.name,
                description: service.description ?? '',
                nature: service.nature,
                unit: service.unit,
                unitPrice: centsToAmountInput(service.unitPriceCents),
                vatRate: bpToPercentInput(service.vatRateBp),
                isActive: service.isActive,
              }}
            />
          </section>

          <form
            action={archiveServiceAction}
            className="rounded-lg border border-border bg-white px-5 py-4"
          >
            <input type="hidden" name="id" value={service.id} />
            <p className="text-sm font-medium text-foreground">Archiver le service</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Il sort du catalogue et des offres
              {service.code ? ', et rend son code' : ''}. Les souscriptions en cours restent
              facturées à leurs conditions : mettez-y fin depuis la fiche de chaque client si le
              service n’est plus rendu.
            </p>
            <button type="submit" className={`mt-3 ${dangerButtonClass}`}>
              Archiver
            </button>
          </form>
        </>
      )}
    </div>
  )
}
