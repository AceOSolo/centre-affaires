import Link from 'next/link'

import { CheckIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import { googleCalendarAddUrl, webcalUrl } from './agenda-ics.ts'
import { createFeedsAction, regenerateFeedAction, removeFeedAction } from './agenda-ics-actions.ts'
import { FeedLinkField } from './agenda-ics-lien.tsx'
import type { ResourceFeed } from './agenda-ics-queries.ts'
import { SubmitButton } from './submit-button.tsx'

/*
 * Espace des agendas (ADR 071) : un lien `.ics` par ressource, à ajouter à
 * Google Agenda, Apple Calendrier ou Outlook.
 */

export type Flash = { failed: boolean; text: string }

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

/** Message de retour d'une action de l'espace, lu dans l'URL. */
export function flashFor(params: { liens?: string; n?: string }): Flash | undefined {
  const n = Number(params.n) || 0
  switch (params.liens) {
    case 'crees':
      return n
        ? {
            failed: false,
            text: `${plural(n, 'lien')} créé${n > 1 ? 's' : ''}. Ajoutez-le à votre agenda avec les boutons de sa ligne.`,
          }
        : { failed: false, text: 'Rien à créer : ces ressources ont déjà leur lien.' }
    case 'regenere':
      return {
        failed: false,
        text: 'Nouveau lien créé. L’ancien ne marche plus : les agendas qui l’avaient ajouté doivent ajouter celui-ci.',
      }
    case 'desactive':
      return {
        failed: false,
        text: 'Lien désactivé : les agendas qui l’avaient ajouté ne reçoivent plus rien de nouveau.',
      }
    case 'aucun':
      return { failed: true, text: 'Cette ressource n’a pas de lien.' }
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
const primaryButton = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover disabled:opacity-50 ${focus}`
const secondaryButton = `inline-flex items-center rounded-md border border-border bg-white px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50 ${focus}`
const dangerButton = `rounded-md border border-destructive/30 bg-white px-3 py-2 text-sm font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5 disabled:opacity-50 ${focus}`

/** Comment ajouter un lien à son agenda, et ce qu'il faut savoir avant. */
export function FeedHowTo() {
  return (
    <section
      aria-labelledby="ajouter-lien-titre"
      className="flex max-w-4xl flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4 text-sm"
    >
      <h2 id="ajouter-lien-titre" className="font-semibold">
        Ajouter un lien à son agenda
      </h2>
      <ul className="flex flex-col gap-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Google Agenda</span> : bouton « Google Agenda » de la
          ressource, puis « Ajouter ». Ou, dans Google Agenda : Autres agendas &gt; « + » &gt; À partir de
          l’URL, et coller le lien.
        </li>
        <li>
          <span className="font-medium text-foreground">Apple Calendrier</span> : bouton « Apple, Outlook », ou
          Fichier &gt; Nouvel abonnement à un calendrier.
        </li>
        <li>
          <span className="font-medium text-foreground">Outlook</span> : bouton « Apple, Outlook », ou Ajouter
          un calendrier &gt; S’abonner à partir du web.
        </li>
      </ul>
      <p className="text-muted-foreground">
        Chaque application relit le lien à son rythme : environ une heure sur iPhone et Mac (réglable jusqu’à
        5 minutes sur Mac), quelques heures sur Outlook, de 8 à 24 heures sur Google Agenda. Pour une
        réservation imminente, le planning du site fait foi.
      </p>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Le lien donne accès au planning sans mot de passe</span> :
        ne le donnez qu’à l’équipe, jamais publiquement — l’objet d’une réservation peut porter le nom d’un
        client. S’il a circulé, régénérez-le. Le nom et les coordonnées des demandeurs n’y figurent jamais.
      </p>
    </section>
  )
}

export function ResourceFeedsTable({ feeds, timeZone }: { feeds: ResourceFeed[]; timeZone: string }) {
  if (feeds.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Aucune ressource. Déclarez d’abord les salles du centre, puis revenez créer leur lien d’agenda.
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

  const missing = feeds.filter((feed) => !feed.url)

  return (
    <section aria-labelledby="liens-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="liens-titre" className="text-sm font-semibold">
            Liens des ressources
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Un agenda par ressource : ajoutez celles que vous voulez suivre.
          </p>
        </div>
        {missing.length > 0 && (
          <form action={createFeedsAction}>
            {missing.map((feed) => (
              <input key={feed.id} type="hidden" name="resourceId" value={feed.id} />
            ))}
            <SubmitButton pendingLabel="Création des liens…" className={primaryButton}>
              {missing.length === feeds.length
                ? 'Créer le lien de toutes les ressources'
                : missing.length === 1
                  ? 'Créer le lien de la ressource restante'
                  : `Créer le lien des ${missing.length} ressources restantes`}
            </SubmitButton>
          </form>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Ressources du centre et leur lien d’agenda</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
              <th scope="col" className="px-4 py-3 font-medium">Lien d’agenda</th>
              <th scope="col" className="px-4 py-3 font-medium">Ajouter à</th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span className="sr-only">Gérer le lien</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {feeds.map((feed) => (
              <tr key={feed.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">{feed.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {resourceTypeLabels[feed.resourceType]} · {feed.code}
                  </div>
                </td>
                {feed.url ? (
                  <>
                    <td className="px-4 py-3">
                      <FeedLinkField id={`lien-${feed.id}`} label={`Lien d’agenda de ${feed.name}`} url={feed.url} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {feed.lastFetchedAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckIcon size={16} className="shrink-0 text-primary" />
                            Lu par un agenda le {formatDateTime(feed.lastFetchedAt, timeZone)}
                          </span>
                        ) : (
                          'Pas encore lu par un agenda.'
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <a href={googleCalendarAddUrl(feed.url)} target="_blank" rel="noreferrer" className={secondaryButton}>
                          Google Agenda<span className="sr-only"> (nouvel onglet), {feed.name}</span>
                        </a>
                        <a href={webcalUrl(feed.url)} className={secondaryButton}>
                          Apple, Outlook<span className="sr-only">, {feed.name}</span>
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <form action={regenerateFeedAction}>
                          <input type="hidden" name="resourceId" value={feed.id} />
                          <SubmitButton pendingLabel="Régénération…" className={secondaryButton}>
                            Régénérer<span className="sr-only"> le lien de {feed.name}</span>
                          </SubmitButton>
                        </form>
                        <form action={removeFeedAction}>
                          <input type="hidden" name="resourceId" value={feed.id} />
                          <SubmitButton pendingLabel="Désactivation…" className={dangerButton}>
                            Désactiver<span className="sr-only"> le lien de {feed.name}</span>
                          </SubmitButton>
                        </form>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 text-muted-foreground">Aucun lien</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3">
                      <form action={createFeedsAction}>
                        <input type="hidden" name="resourceId" value={feed.id} />
                        <SubmitButton pendingLabel="Création…" className={secondaryButton}>
                          Créer le lien<span className="sr-only"> de {feed.name}</span>
                        </SubmitButton>
                      </form>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
