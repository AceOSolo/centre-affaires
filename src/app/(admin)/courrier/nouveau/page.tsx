import Link from 'next/link'

import { CheckIcon } from '../../../../components/ui/icons.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { toWallClock } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import { MailForm } from '../../../../modules/courrier/mail-form.tsx'
import { findMail } from '../../../../modules/courrier/queries.ts'

export const metadata = { title: 'Enregistrer un courrier' }

export default async function NouveauCourrierPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; enregistre?: string }>
}) {
  await requirePermission('courrier.gerer')
  const { clientId, enregistre } = await searchParams
  const [timeZone, clients, registered] = await Promise.all([
    currentTimeZone(),
    listClients(),
    enregistre ? findMail(enregistre) : undefined,
  ])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          ← Courrier
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Enregistrer un courrier</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Le pli apparaît aussitôt dans l’espace du client, qui peut en demander l’ouverture.
        </p>
      </div>

      {registered && (
        <p
          role="status"
          className="flex max-w-3xl flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
        >
          <CheckIcon size={20} />
          Courrier enregistré pour {registered.clientName}.
          <Link href={`/courrier/${registered.id}`} className="font-medium underline underline-offset-2">
            Voir le courrier
          </Link>
        </p>
      )}

      {clients.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucun client. Le courrier s’enregistre au nom d’une entreprise : créez d’abord sa fiche.
          </p>
          <Link
            href="/clients/nouveau"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Créer un client
          </Link>
        </div>
      ) : (
        <MailForm
          // Remonté après chaque enregistrement : formulaire vide, heure du moment.
          key={registered?.id ?? 'nouveau'}
          clients={clients.map((client) => ({ id: client.id, name: client.name }))}
          defaultClientId={clients.some((client) => client.id === clientId) ? clientId : undefined}
          defaultReceivedAt={toWallClock(new Date(), timeZone)}
        />
      )}
    </div>
  )
}
