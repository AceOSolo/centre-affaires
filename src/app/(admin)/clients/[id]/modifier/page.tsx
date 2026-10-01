import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { ClientForm } from '../../../../../modules/clients/client-form.tsx'
import { findClient } from '../../../../../modules/clients/queries.ts'

export const metadata = { title: 'Modifier le client' }

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('clients.gerer')
  const { id } = await params
  const client = await findClient(id)
  if (!client) notFound()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {client.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modifier la fiche</h1>
      </div>
      <ClientForm client={client} />
    </div>
  )
}
