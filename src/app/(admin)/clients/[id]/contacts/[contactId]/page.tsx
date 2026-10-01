import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { ContactForm } from '../../../../../../modules/clients/contact-form.tsx'
import { removeClientContactAction } from '../../../../../../modules/clients/contacts-actions.ts'
import {
  findClientContact,
  listClientContacts,
} from '../../../../../../modules/clients/contacts-queries.ts'
import { findClient } from '../../../../../../modules/clients/queries.ts'

export const metadata = { title: 'Modifier le contact' }

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string; contactId: string }>
}) {
  await requirePermission('clients.gerer')
  const { id, contactId } = await params
  if (!isUuid(id) || !isUuid(contactId)) notFound()
  const [client, contact] = await Promise.all([findClient(id), findClientContact(id, contactId)])
  // Fiche archivée ou contact retiré : plus rien à modifier.
  if (!client || client.deletedAt || !contact) notFound()

  const primary = contact.isPrimary
    ? undefined
    : (await listClientContacts(client.id)).find((candidate) => candidate.isPrimary)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/clients/${client.id}`} className="text-sm text-muted-foreground hover:underline">
          ← {client.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{contact.fullName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Contact de {client.name}</p>
      </div>

      <ContactForm
        clientId={client.id}
        contact={contact}
        currentPrimaryName={primary?.fullName ?? null}
      />

      {/* Retrait logique (décision 6) : la ligne reste en base, le contact
          sort de la fiche. Séparé du formulaire pour ne pas se déclencher en
          validant par Entrée. */}
      <form
        action={removeClientContactAction}
        className="max-w-3xl rounded-lg border border-border bg-white px-5 py-4"
      >
        <input type="hidden" name="clientId" value={client.id} />
        <input type="hidden" name="id" value={contact.id} />
        <p className="text-sm font-medium text-foreground">Retirer le contact</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {contact.isPrimary
            ? 'Il n’apparaît plus sur la fiche, qui n’a alors plus de contact principal tant que vous n’en désignez pas un autre.'
            : 'Il n’apparaît plus sur la fiche. Ses éventuels accès à l’espace client ne changent pas.'}
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
        >
          Retirer le contact
        </button>
      </form>
    </div>
  )
}
