import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import {
  notificationAudienceLabels,
  notificationCategoryLabels,
  notificationEventDescriptions,
  notificationEventLabels,
} from '../../../../../modules/notifications/catalogue.ts'
import { findTemplateState } from '../../../../../modules/notifications/queries.ts'
import {
  notificationEventAudience,
  notificationEventCategory,
  notificationEvents,
  type NotificationEvent,
} from '../../../../../modules/notifications/schema.ts'
import { TemplateEditor } from '../../../../../modules/notifications/template-editor.tsx'

export async function generateMetadata({ params }: { params: Promise<{ evenement: string }> }) {
  const { evenement } = await params
  const event = (notificationEvents as readonly string[]).includes(evenement)
    ? (evenement as NotificationEvent)
    : undefined
  return { title: event ? `Modèle — ${notificationEventLabels[event]}` : 'Modèle de message' }
}

/** Modèle d'un événement : édition, aperçu, retour au texte par défaut (ADR 038). */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ evenement: string }>
  searchParams: Promise<{ fait?: string; v?: string }>
}) {
  await requirePermission('notifications.gerer')
  const { evenement } = await params
  if (!(notificationEvents as readonly string[]).includes(evenement)) notFound()
  const event = evenement as NotificationEvent
  const [state, tenant, { fait, v }] = await Promise.all([findTemplateState(event), currentTenant(), searchParams])
  const category = notificationEventCategory[event]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/notifications/modeles"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Modèles des messages
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{notificationEventLabels[event]}</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          {notificationEventDescriptions[event]} Destinataire :{' '}
          {notificationAudienceLabels[notificationEventAudience[event]].toLowerCase()}.{' '}
          {category
            ? `Une personne de l’espace client peut le refuser en décochant « ${notificationCategoryLabels[category]} » dans ses préférences.`
            : 'Toujours envoyé : il ne se refuse pas dans les préférences.'}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {state.updatedAt
            ? `Modifié le ${formatDateTime(state.updatedAt, tenant.timezone)}${state.updatedByName ? ` par ${state.updatedByName}` : ''}.`
            : 'Texte par défaut de l’application, jamais modifié.'}
        </p>
      </div>

      {fait === 'reinitialise' && (
        <FlashNotice key={v}>Le texte par défaut est rétabli.</FlashNotice>
      )}

      <TemplateEditor
        // Remonté après un retour au texte par défaut, qui redirige avec une
        // version : il repart de la base. Un enregistrement ne le remonte pas,
        // sa confirmation reste affichée.
        key={fait === 'reinitialise' ? `reinitialise-${v ?? ''}` : 'edition'}
        event={event}
        initial={{ subject: state.subject, body: state.body, active: state.active }}
        centreName={tenant.name}
        customized={state.customized}
      />
    </div>
  )
}
