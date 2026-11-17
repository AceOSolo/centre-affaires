import { notFound } from 'next/navigation'

import { LienRetour } from '../../../../../components/ui/lien-retour.tsx'
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
        <LienRetour href={`/clients/${client.id}`} label={<>{client.name}</>} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modifier la fiche</h1>
      </div>
      {/* Une fiche anonymisée ne change plus (CA012, ADR 040). */}
      {client.anonymizedAt ? (
        <p className="max-w-[70ch] rounded-lg border border-border bg-white px-5 py-4 text-sm">
          Cette fiche est anonymisée : elle ne se modifie plus. Ses factures émises gardent
          l’identité de l’acheteur figée à leur émission.
        </p>
      ) : (
        <ClientForm client={client} />
      )}
    </div>
  )
}
