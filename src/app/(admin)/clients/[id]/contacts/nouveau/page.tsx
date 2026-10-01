import Link from 'next/link'
import { notFound } from 'next/navigation'

import { isUuid } from '../../../../../../lib/uuid.ts'
import { ContactForm } from '../../../../../../modules/clients/contact-form.tsx'
import { listClientContacts } from '../../../../../../modules/clients/contacts-queries.ts'
import { findClient } from '../../../../../../modules/clients/queries.ts'

export const metadata = { title: 'Nouveau contact' }

export default async function NewContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const client = await findClient(id)
  // Une fiche archivée ne reçoit plus de contact.
  if (!client || client.deletedAt) notFound()

  const contacts = await listClientContacts(client.id)
  const primary = contacts.find((contact) => contact.isPrimary)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/clients/${client.id}`} className="text-sm text-muted-foreground hover:underline">
          ← {client.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouveau contact</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Une personne à joindre chez {client.name}. Le contact ne reçoit aucun accès à l’espace
          client : les accès se donnent depuis la fiche, dans « Accès à l’espace client ».
        </p>
      </div>
      <ContactForm
        clientId={client.id}
        currentPrimaryName={primary?.fullName ?? null}
        // Le premier contact d'une fiche en est presque toujours l'interlocuteur.
        defaultPrimary={contacts.length === 0}
      />
    </div>
  )
}
