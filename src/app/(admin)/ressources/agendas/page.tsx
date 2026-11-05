import { requirePermission } from '../../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import {
  FeedHowTo,
  FlashMessage,
  ResourceFeedsTable,
  flashFor,
} from '../../../../modules/reservations/agenda-ics-panel.tsx'
import { feedsAvailable, listResourceFeeds } from '../../../../modules/reservations/agenda-ics-queries.ts'

export const metadata = { title: 'Agendas' }

/**
 * Espace des agendas (ADR 071) : un lien par ressource, à ajouter à Google
 * Agenda, Apple Calendrier ou Outlook, qui montre ses réservations confirmées.
 */
export default async function AgendasPage({
  searchParams,
}: {
  searchParams: Promise<{ liens?: string; n?: string }>
}) {
  const [, timeZone, feeds, params] = await Promise.all([
    requirePermission('agenda-google.gerer'),
    currentTimeZone(),
    listResourceFeeds(),
    searchParams,
  ])
  const flash = flashFor(params)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agendas</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Chaque ressource peut avoir son lien d’agenda. Ajouté à Google Agenda, Apple Calendrier ou
          Outlook, il y montre ses réservations confirmées, et les suit quand elles sont déplacées ou
          annulées.
        </p>
      </div>

      {flash && <FlashMessage flash={flash} />}

      {feedsAvailable() ? (
        <>
          <FeedHowTo />
          <ResourceFeedsTable feeds={feeds} timeZone={timeZone} />
        </>
      ) : (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          Le serveur n’a pas son adresse (APP_URL) ou sa clé de connexion (AUTH_SECRET) : les liens
          d’agenda ne peuvent pas être créés. Elles se posent par la personne qui installe le serveur
          (infra/serveur/README.md).
        </p>
      )}
    </div>
  )
}
