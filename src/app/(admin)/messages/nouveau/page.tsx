import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { listBroadcastCandidates } from '../../../../modules/notifications/diffusion.ts'
import { BroadcastForm } from '../../../../modules/notifications/diffusion-form.tsx'

export const metadata = { title: 'Nouveau message aux clients' }

/**
 * Nouveau message aux domiciliés (ADR 060) : destinataires, objet, texte,
 * aperçu, puis confirmation avec le nombre de destinataires.
 */
export default async function NewMessagePage() {
  await requirePermission('notifications.diffuser')
  const candidates = await listBroadcastCandidates()

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/messages" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Messages aux domiciliés
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Nouveau message</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Le message part par courriel à chaque personne de l’espace client des entreprises choisies,
          chacune recevant son exemplaire. Il ne transporte aucun document. L’aperçu dit à combien
          d’entreprises et de personnes il partira ; rien ne part avant votre confirmation.
        </p>
      </div>
      <BroadcastForm candidates={candidates} />
    </div>
  )
}
