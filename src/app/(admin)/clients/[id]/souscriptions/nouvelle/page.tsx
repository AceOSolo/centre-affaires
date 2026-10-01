import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { findClient } from '../../../../../../modules/clients/queries.ts'
import { contractStatusLabels } from '../../../../../../modules/contrats/labels.ts'
import { bpToPercentInput } from '../../../../../../modules/facturation/saisie.ts'
import {
  listSubscribableServices,
  listSubscriptionContracts,
} from '../../../../../../modules/facturation/souscriptions-queries.ts'
import { SubscriptionForm } from '../../../../../../modules/facturation/subscription-form.tsx'

export const metadata = { title: 'Souscrire un service' }

/**
 * Souscription d'un client à un service du catalogue (R18). `?contrat=`
 * rattache d'office la souscription à l'un de ses contrats.
 */
export default async function NewSubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ contrat?: string }>
}) {
  await requirePermission('souscriptions.gerer')
  const [{ id }, { contrat }, tenant] = await Promise.all([params, searchParams, currentTenant()])
  if (!isUuid(id)) notFound()
  const client = await findClient(id)
  if (!client) notFound()

  const [services, contracts] = await Promise.all([
    listSubscribableServices(),
    listSubscriptionContracts(client.id),
  ])
  const contractId = contracts.some((contract) => contract.id === contrat) ? (contrat ?? '') : ''

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/clients/${client.id}#services`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {client.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Souscrire un service</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Le prix et la TVA proposés sont ceux du catalogue ; ils sont figés à l’enregistrement.
          Pour un acte, les actes inclus de chaque mois sont facturés 0 €, les suivants au prix
          saisi.
        </p>
      </div>

      {client.deletedAt ? (
        <p className="rounded-lg border border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Cette fiche client est archivée : elle ne souscrit plus de service.
        </p>
      ) : (
        <SubscriptionForm
          mode="create"
          clientId={client.id}
          services={services.map((service) => ({
            id: service.id,
            name: service.name,
            nature: service.nature,
            unit: service.unit,
            unitPriceCents: service.unitPriceCents,
            vatRateBp: service.vatRateBp,
            currency: service.currency,
          }))}
          contracts={contracts.map((contract) => ({
            id: contract.id,
            reference: contract.reference,
            statusLabel: contractStatusLabels[contract.status],
          }))}
          defaults={{
            serviceId: '',
            contractId,
            quantity: '1',
            unitPrice: '',
            discountKind: 'none',
            discountPercent: '',
            discountAmount: '',
            vatRate: bpToPercentInput(tenant.defaultVatRateBp),
            includedQuantity: '0',
            startsOn: todayIsoDate(tenant.timezone),
            endsOn: '',
            effectiveOn: '',
            notes: '',
          }}
        />
      )}
    </div>
  )
}
