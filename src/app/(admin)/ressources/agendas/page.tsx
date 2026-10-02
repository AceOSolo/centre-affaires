import { requireStaff } from '../../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { googleConfig } from '../../../../modules/reservations/agenda-google.ts'
import {
  FlashMessage,
  GoogleAccountPanel,
  ResourceCalendarsTable,
  flashFor,
} from '../../../../modules/reservations/agenda-google-panel.tsx'
import {
  googleCalendarStatus,
  listResourceCalendarLinks,
} from '../../../../modules/reservations/agenda-google-queries.ts'

export const metadata = { title: 'Agendas Google' }

/**
 * Espace des agendas Google (ADR 014) : un compte Google pour le centre, un
 * agenda par ressource, où s'écrivent ses réservations confirmées.
 */
export default async function AgendasPage({
  searchParams,
}: {
  searchParams: Promise<{ compte?: string; agendas?: string; n?: string; echecs?: string }>
}) {
  const [{ member }, timeZone, status, links, params] = await Promise.all([
    requireStaff(),
    currentTimeZone(),
    googleCalendarStatus(),
    listResourceCalendarLinks(),
    searchParams,
  ])
  const isAdmin = member.role === 'admin'
  const flash = flashFor(params)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agendas Google</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Chaque ressource reliée a son agenda dans le compte Google du centre. Ses réservations
          confirmées — demandes acceptées comme réservations de l’équipe — y sont écrites, puis
          déplacées ou retirées avec elles. Le nom et les coordonnées des demandeurs n’y figurent
          pas.
        </p>
      </div>

      {flash && <FlashMessage flash={flash} />}

      <GoogleAccountPanel
        status={status}
        isAdmin={isAdmin}
        configured={googleConfig() !== undefined}
        timeZone={timeZone}
      />

      <section aria-labelledby="agendas-ressources-titre" className="flex flex-col gap-3">
        <div>
          <h2 id="agendas-ressources-titre" className="text-sm font-semibold">
            Agendas des ressources
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {!status
              ? 'Connectez d’abord un compte Google.'
              : isAdmin
                ? 'Cochez les ressources, puis créez leur agenda : les réservations à venir y sont recopiées. Retirer la liaison laisse l’agenda dans Google, sans plus le tenir à jour.'
                : 'Seul un administrateur peut créer ou retirer un agenda.'}
          </p>
        </div>
        <ResourceCalendarsTable
          links={links}
          canEdit={isAdmin && Boolean(status)}
          timeZone={timeZone}
        />
      </section>
    </div>
  )
}
