import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import { ContractForm } from '../../../../modules/contrats/contract-form.tsx'
import { listRatePlans } from '../../../../modules/facturation/queries.ts'
import { listResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouveau contrat' }

export default async function NewContractPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>
}) {
  await requirePermission('contrats.creer')
  const { clientId } = await searchParams
  const [clients, ratePlans, resources] = await Promise.all([
    listClients(),
    listRatePlans(),
    listResources(),
  ])
  const known = clients.some((client) => client.id === clientId)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/contrats" className="text-sm text-muted-foreground hover:underline">
          ← Contrats
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouveau contrat</h1>
      </div>
      <ContractForm
        clients={clients}
        ratePlans={ratePlans}
        resources={resources}
        defaultClientId={known ? clientId : undefined}
      />
    </div>
  )
}
