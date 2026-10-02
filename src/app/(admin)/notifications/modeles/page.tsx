import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import {
  notificationCategoryLabels,
  notificationEventDescriptions,
  notificationEventLabels,
} from '../../../../modules/notifications/catalogue.ts'
import { listTemplateStates, type TemplateState } from '../../../../modules/notifications/queries.ts'
import {
  notificationEventAudience,
  notificationEventCategory,
  notificationEvents,
} from '../../../../modules/notifications/schema.ts'

export const metadata = { title: 'Modèles des messages' }

function TemplatesTable({ caption, states }: { caption: string; states: TemplateState[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Message</th>
            <th scope="col" className="px-4 py-3 font-medium">Préférence</th>
            <th scope="col" className="px-4 py-3 font-medium">Texte</th>
            <th scope="col" className="px-4 py-3 font-medium">Envoi</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border align-top">
          {states.map((state) => {
            const category = notificationEventCategory[state.event]
            return (
              <tr key={state.event}>
                <td className="px-4 py-3">
                  <Link
                    href={`/notifications/modeles/${state.event}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {notificationEventLabels[state.event]}
                  </Link>
                  <p className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">
                    {notificationEventDescriptions[state.event]}
                  </p>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {category ? `« ${notificationCategoryLabels[category]} »` : 'Toujours envoyé'}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {state.customized ? 'Personnalisé' : 'Texte par défaut'}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      state.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {state.active ? 'Actif' : 'Désactivé : rien n’est envoyé'}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Modèles des messages (R26, ADR 038), réservés à l'exploitant : un par
 * événement. Sans modèle écrit, le texte par défaut part.
 */
export default async function TemplatesPage() {
  await requirePermission('notifications.gerer')
  const states = await listTemplateStates(notificationEvents)
  const toClients = states.filter((state) => notificationEventAudience[state.event] === 'client')
  const toCentre = states.filter((state) => notificationEventAudience[state.event] === 'centre')

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/notifications" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Messages envoyés
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Modèles des messages</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Le texte de chaque courriel que l’application envoie. Tant qu’un modèle n’est pas
          personnalisé, le texte par défaut part. Un courriel prévient, il ne contient jamais de
          document. La colonne « Préférence » dit dans quelle catégorie une personne de l’espace client
          peut refuser le message.
        </p>
      </div>

      <section aria-labelledby="clients-title" className="flex flex-col gap-3">
        <h2 id="clients-title" className="text-lg font-semibold tracking-tight">
          Messages aux clients
        </h2>
        <TemplatesTable caption="Modèles des messages aux clients" states={toClients} />
      </section>

      <section aria-labelledby="centre-title" className="flex flex-col gap-3">
        <h2 id="centre-title" className="text-lg font-semibold tracking-tight">
          Messages au centre
        </h2>
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          Envoyés à l’adresse de courriel du centre, renseignée dans la configuration.
        </p>
        <TemplatesTable caption="Modèles des messages au centre" states={toCentre} />
      </section>
    </div>
  )
}
