import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { findClient, listClients } from '../../../../../modules/clients/queries.ts'
import { ContractForm } from '../../../../../modules/contrats/contract-form.tsx'
import { centsToAmountInput } from '../../../../../modules/contrats/formulaire.ts'
import { contractStatusLabels } from '../../../../../modules/contrats/labels.ts'
import { formatBpAsPercent } from '../../../../../modules/contrats/lignes.ts'
import { findContract } from '../../../../../modules/contrats/queries.ts'
import { findContractTerms } from '../../../../../modules/contrats/versions.ts'
import { listRatePlans } from '../../../../../modules/facturation/queries.ts'
import { listResources } from '../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Modifier le brouillon' }

/**
 * Modification d'un contrat en brouillon (R12). Mêmes champs et mêmes règles
 * que la création. Un contrat actif, résilié ou archivé ne se modifie plus
 * ici : il engage le centre et le client.
 */
export default async function EditContractPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('contrats.creer')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const contract = await findContract(id)
  if (!contract) notFound()

  const editable = contract.status === 'draft' && contract.deletedAt === null

  if (!editable) {
    return (
      <div className="flex flex-col gap-6">
        <Link href={`/contrats/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← Contrat {contract.reference}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Modifier le brouillon</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          {contract.deletedAt
            ? 'Ce contrat est archivé : désarchivez-le pour le modifier.'
            : `Ce contrat n’est plus un brouillon (${contractStatusLabels[contract.status].toLowerCase()}) : il engage le centre et le client, et ne se modifie plus ici.`}{' '}
          <Link href={`/contrats/${id}`} className="underline underline-offset-2">
            Revenir au contrat
          </Link>
        </p>
      </div>
    )
  }

  const [clients, ratePlans, resources, currentClient] = await Promise.all([
    listClients(),
    listRatePlans(),
    listResources(),
    findClient(contract.clientId),
  ])

  // Le client et la ressource du brouillon restent proposés même s'ils ont été
  // archivés depuis : la liste ne doit pas changer la saisie en silence.
  const clientOptions = clients.map((client) => ({ id: client.id, name: client.name }))
  if (currentClient && !clientOptions.some((client) => client.id === currentClient.id)) {
    clientOptions.unshift({ id: currentClient.id, name: `${currentClient.name} (archivé)` })
  }
  const resourceOptions =
    contract.resource && !resources.some((resource) => resource.id === contract.resource?.id)
      ? [contract.resource, ...resources]
      : resources
  const ratePlanOptions =
    contract.ratePlan && !ratePlans.some((plan) => plan.id === contract.ratePlan?.id)
      ? [contract.ratePlan, ...ratePlans]
      : ratePlans
  // Avec des lignes récurrentes, la base tient le montant égal à leur somme
  // (ADR 025) : le champ ne fait que l'afficher.
  const { versions } = await findContractTerms(id)
  const amountFromLines =
    versions
      .find((version) => version.amendmentId === null)
      ?.lines.some((line) => line.isRecurring) ?? false

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/contrats/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← Contrat {contract.reference}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modifier le brouillon</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {contract.reference} — {contract.client.name}
        </p>
      </div>
      <ContractForm
        clients={clientOptions}
        ratePlans={ratePlanOptions}
        resources={resourceOptions}
        amountFromLines={amountFromLines}
        contract={{
          id: contract.id,
          clientId: contract.clientId,
          reference: contract.reference,
          contractType: contract.contractType,
          resourceId: contract.resourceId ?? '',
          startsOn: contract.startsOn,
          endsOn: contract.endsOn ?? '',
          billingPeriod: contract.billingPeriod,
          amount: centsToAmountInput(contract.amountCents),
          noticeDays: String(contract.noticeDays),
          ratePlanId: contract.ratePlanId ?? '',
          notes: contract.notes ?? '',
          vatRate: formatBpAsPercent(contract.vatRateBp),
          commitmentMonths: contract.commitmentMonths ? String(contract.commitmentMonths) : '',
          tacitRenewal: contract.tacitRenewal ? 'on' : '',
          renewalMonths: contract.renewalMonths ? String(contract.renewalMonths) : '',
        }}
      />
    </div>
  )
}
