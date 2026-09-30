import Link from 'next/link'

import { CalendarIcon, CheckIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import {
  connectGoogleCalendarAction,
  createResourceCalendarsAction,
  disconnectGoogleCalendarAction,
  removeResourceCalendarsAction,
} from './agenda-google-actions.ts'
import type {
  ConnectionOutcome,
  GoogleCalendarStatus,
  ResourceCalendarLink,
} from './agenda-google-queries.ts'
import { SubmitButton } from './submit-button.tsx'

/*
 * Espace des agendas Google (ADR 014) : le compte du centre, puis un agenda
 * par ressource. Seul un administrateur agit ; le reste de l'équipe voit
 * l'état.
 */

export type Flash = { failed: boolean; text: string }

const accountOutcomes: Record<ConnectionOutcome, Flash> = {
  connecte: {
    failed: false,
    text: 'Compte Google connecté. Créez maintenant l’agenda des ressources à suivre.',
  },
  deconnecte: {
    failed: false,
    text: 'Compte Google déconnecté. Les agendas restent dans le compte Google : les supprimer depuis Google Agenda si vous n’en voulez plus.',
  },
  refuse: { failed: true, text: 'Connexion annulée : l’accès n’a pas été accordé sur la page de Google.' },
  portee: {
    failed: true,
    text: 'Google n’a pas transmis l’accès aux agendas. Recommencez en cochant l’autorisation Google Agenda.',
  },
  expire: { failed: true, text: 'La demande de connexion a expiré. Recommencez.' },
  erreur: {
    failed: true,
    text: 'La connexion à Google a échoué. Recommencez ; si l’échec persiste, vérifiez le projet Google Cloud (ADR 014).',
  },
  'non-configure': { failed: true, text: 'Google Agenda n’est pas configuré sur ce serveur.' },
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

/** Message de retour d'une action de l'espace, lu dans l'URL. */
export function flashFor(params: {
  compte?: string
  agendas?: string
  n?: string
  echecs?: string
}): Flash | undefined {
  if (params.compte && Object.hasOwn(accountOutcomes, params.compte)) {
    return accountOutcomes[params.compte as ConnectionOutcome]
  }
  const n = Number(params.n) || 0
  const failed = Number(params.echecs) || 0
  switch (params.agendas) {
    case 'vide':
      return { failed: true, text: 'Cochez au moins une ressource.' }
    case 'retires':
      return {
        failed: false,
        text: `${plural(n, 'liaison')} retirée${n > 1 ? 's' : ''}. Les agendas restent dans le compte Google et ne sont plus tenus à jour.`,
      }
    case 'crees':
      if (failed) {
        return {
          failed: true,
          text: `${plural(n, 'agenda')} créé${n > 1 ? 's' : ''}, ${failed} en échec : voir le dernier échec du compte Google.`,
        }
      }
      return n
        ? {
            failed: false,
            text: `${plural(n, 'agenda')} créé${n > 1 ? 's' : ''}. Les réservations à venir y sont recopiées dans les minutes qui viennent.`,
          }
        : { failed: false, text: 'Rien à créer : les ressources cochées ont déjà leur agenda.' }
  }
  return undefined
}

export function FlashMessage({ flash }: { flash: Flash }) {
  return (
    <p
      role={flash.failed ? 'alert' : 'status'}
      className={`rounded-sm px-3 py-2 text-sm ${
        flash.failed
          ? 'border border-destructive/30 bg-destructive/5 text-destructive'
          : 'border border-border bg-white text-foreground'
      }`}
    >
      {flash.text}
    </p>
  )
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const primaryButton = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50 ${focus}`
const secondaryButton = `rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 ${focus}`

export function GoogleAccountPanel({
  status,
  isAdmin,
  configured,
  timeZone,
}: {
  status: GoogleCalendarStatus | undefined
  isAdmin: boolean
  configured: boolean
  timeZone: string
}) {
  // Un échec suivi d'une réussite ne dit plus rien de l'état présent. À égalité
  // — même lot —, l'échec l'emporte : c'est lui qui demande une action.
  const failedAt =
    status?.lastErrorAt && (!status.lastSyncedAt || status.lastErrorAt >= status.lastSyncedAt)
      ? status.lastErrorAt
      : undefined

  return (
    <section
      aria-labelledby="compte-google-titre"
      className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <CalendarIcon size={20} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 id="compte-google-titre" className="text-sm font-semibold">
            Compte Google
          </h2>
          {status ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Connecté à <span className="break-all text-foreground">{status.googleEmail}</span>{' '}
                depuis le {formatDateTime(status.connectedAt, timeZone)}. L’application n’a accès
                qu’aux agendas qu’elle y crée.
              </p>
              {failedAt ? (
                <p className="mt-2 text-sm text-destructive">
                  <span className="font-medium">Échec de la dernière écriture</span>, le{' '}
                  {formatDateTime(failedAt, timeZone)} : {status.lastError}
                </p>
              ) : (
                status.lastSyncedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Dernière écriture le {formatDateTime(status.lastSyncedAt, timeZone)}.
                  </p>
                )
              )}
            </>
          ) : !configured ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {isAdmin
                ? 'Non configuré sur ce serveur : renseigner GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SECRETS_ENCRYPTION_KEY et APP_URL (ADR 014).'
                : 'Google Agenda n’est pas configuré sur ce serveur.'}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              {isAdmin
                ? 'Aucun compte connecté. L’application y créera un agenda par ressource, sans accès aux autres agendas du compte.'
                : 'Aucun compte connecté. Un administrateur peut le faire.'}
            </p>
          )}
        </div>
      </div>

      {isAdmin && !status && configured && (
        <form action={connectGoogleCalendarAction} className="shrink-0">
          <SubmitButton pendingLabel="Redirection vers Google…" className={primaryButton}>
            Connecter un compte Google
          </SubmitButton>
        </form>
      )}
      {isAdmin && status && (
        // Confirmation sans script : la déconnexion défait toutes les liaisons,
        // un clic isolé ne doit pas y suffire.
        <details className="shrink-0 sm:max-w-xs">
          <summary className={`${secondaryButton} cursor-pointer list-none text-center`}>
            Déconnecter…
          </summary>
          <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              Toutes les ressources perdent leur agenda. Les agendas restent dans le compte Google,
              sans plus être tenus à jour.
            </p>
            <form action={disconnectGoogleCalendarAction}>
              <SubmitButton
                pendingLabel="Déconnexion…"
                className={`w-full rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50 ${focus}`}
              >
                Confirmer la déconnexion
              </SubmitButton>
            </form>
          </div>
        </details>
      )}
    </section>
  )
}

export function ResourceCalendarsTable({
  links,
  canEdit,
  timeZone,
}: {
  links: ResourceCalendarLink[]
  /** Administrateur, avec un compte Google connecté. */
  canEdit: boolean
  timeZone: string
}) {
  if (links.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Aucune ressource. Déclarez d’abord les salles du centre, puis revenez leur créer un agenda.
        </p>
        <Link
          href="/ressources/nouvelle"
          className={`mt-4 inline-block text-sm text-primary underline underline-offset-2 ${focus}`}
        >
          Déclarer une ressource
        </Link>
      </div>
    )
  }

  const table = (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Ressources du centre et leur agenda Google</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {canEdit && (
              <th scope="col" className="w-12 px-4 py-3 font-medium">
                <span className="sr-only">Sélection</span>
              </th>
            )}
            <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
            <th scope="col" className="px-4 py-3 font-medium">Type</th>
            <th scope="col" className="px-4 py-3 font-medium">Agenda Google</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {links.map((link) => (
            <tr key={link.id}>
              {canEdit && (
                <td className="px-4 py-2">
                  {/* Le label agrandit la cible au-delà des 24 px demandés. */}
                  <label className="inline-flex size-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      name="resourceIds"
                      value={link.id}
                      className={`size-4 accent-primary ${focus}`}
                    />
                    <span className="sr-only">Sélectionner {link.name}</span>
                  </label>
                </td>
              )}
              <td className="px-4 py-3">
                <div className="font-medium">{link.name}</div>
                <div className="text-xs text-muted-foreground">{link.code}</div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {resourceTypeLabels[link.resourceType]}
              </td>
              <td className="px-4 py-3">
                {link.linkedAt ? (
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <CheckIcon size={20} className="shrink-0 text-primary" />
                    Relié depuis le {formatDateTime(link.linkedAt, timeZone)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Non relié</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  if (!canEdit) return table

  return (
    <form className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          formAction={createResourceCalendarsAction}
          pendingLabel="Création des agendas…"
          className={primaryButton}
        >
          Créer l’agenda des ressources cochées
        </SubmitButton>
        <SubmitButton
          formAction={removeResourceCalendarsAction}
          pendingLabel="Retrait…"
          className={secondaryButton}
        >
          Retirer leur liaison
        </SubmitButton>
      </div>
      {table}
    </form>
  )
}
