import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { parseKey } from '../../../../lib/chiffrement.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { googleRedirectUri } from '../../../../modules/reservations/agenda-google.ts'
import {
  FlashMessage,
  GoogleAccountPanel,
  GoogleClientSetup,
  ResourceCalendarsEmbed,
  ResourceCalendarsTable,
  flashFor,
} from '../../../../modules/reservations/agenda-google-panel.tsx'
import {
  googleCalendarStatus,
  googleClientStatus,
  listGoogleCalendarChoices,
  listResourceCalendarLinks,
  loadGoogleConfig,
} from '../../../../modules/reservations/agenda-google-queries.ts'

function encryptionReady(): boolean {
  try {
    parseKey(process.env.SECRETS_ENCRYPTION_KEY)
    return true
  } catch {
    return false
  }
}

export const metadata = { title: 'Agendas Google' }

/**
 * Espace des agendas Google (ADR 014) : un compte Google pour le centre, un
 * agenda par ressource, où s'écrivent ses réservations confirmées. Les
 * identifiants Google Cloud du centre s'y règlent aussi (ADR 069).
 */
export default async function AgendasPage({
  searchParams,
}: {
  searchParams: Promise<{ compte?: string; agendas?: string; n?: string; echecs?: string }>
}) {
  const [{ member }, timeZone, status, client, config, links, choices, params] = await Promise.all([
    requirePermission('agenda-google.gerer'),
    currentTimeZone(),
    googleCalendarStatus(),
    googleClientStatus(),
    loadGoogleConfig(),
    listResourceCalendarLinks(),
    // Un appel à Google à chaque affichage : la liste doit montrer les agendas
    // tels qu'ils sont dans le compte, renommés ou supprimés compris (ADR 072).
    listGoogleCalendarChoices(),
    searchParams,
  ])
  const calendars = choices && 'calendars' in choices ? choices.calendars : undefined
  const calendarsError = choices && 'error' in choices ? choices : undefined
  // Par le droit, pas par la valeur du rôle : la direction l'a aussi (ADR 054).
  const isAdmin = can(member.role, 'agenda-google.gerer')
  const flash = flashFor(params)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agendas Google</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Choisissez, pour chaque salle, son agenda dans le compte Google du centre. Ses
          réservations confirmées — demandes acceptées comme réservations de l’équipe — y sont
          écrites en quelques secondes, puis déplacées ou retirées avec elles. Le nom et les
          coordonnées des demandeurs n’y figurent pas.
        </p>
      </div>

      {flash && <FlashMessage flash={flash} />}

      <GoogleAccountPanel
        status={status}
        isAdmin={isAdmin}
        configured={config !== undefined}
        timeZone={timeZone}
        calendarsError={calendarsError}
      />

      {/* Un compte connecté garde les identifiants avec lesquels il l'a été. */}
      {isAdmin && !status && (
        <GoogleClientSetup
          client={client}
          configured={config !== undefined}
          encryptionReady={encryptionReady()}
          redirectUri={googleRedirectUri(process.env.APP_URL ?? 'http://localhost:3000')}
          timeZone={timeZone}
        />
      )}

      <section aria-labelledby="agendas-ressources-titre" className="flex flex-col gap-3">
        <div>
          <h2 id="agendas-ressources-titre" className="text-sm font-semibold">
            Agendas des ressources
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {!status
              ? 'Connectez d’abord un compte Google.'
              : !isAdmin
                ? 'Seul un administrateur peut choisir l’agenda d’une salle.'
                : calendarsError
                  ? 'La liste des agendas du compte n’a pas pu être lue : voir l’encart « Compte Google ».'
                  : 'Choisissez l’agenda de chaque salle, puis enregistrez : les réservations à venir y sont recopiées. Seules les réservations du site y sont écrites ; vos autres événements ne sont ni lus ni touchés. Seuls les agendas dont le compte est propriétaire sont proposés.'}
          </p>
        </div>
        <ResourceCalendarsTable
          links={links}
          calendars={calendars}
          canEdit={isAdmin && Boolean(status)}
          timeZone={timeZone}
        />
      </section>

      {/* Pour la page « aide outils » de Dolibarr (ADR 064). */}
      <ResourceCalendarsEmbed links={links} timeZone={timeZone} />
    </div>
  )
}
