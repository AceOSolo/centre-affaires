import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { ClientForm } from '../../../../modules/clients/client-form.tsx'

export const metadata = { title: 'Nouveau client' }

export default async function NewClientPage() {
  await requirePermission('clients.gerer')
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouveau client</h1>
      </div>
      <ClientForm />
    </div>
  )
}
