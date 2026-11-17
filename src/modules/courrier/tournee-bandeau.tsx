import Link from 'next/link'

import { CheckIcon, ClockIcon, MailIcon } from '../../components/ui/icons.tsx'
import { formatTime } from '../../lib/dates.ts'
import type { DayReport, OpenBatch } from './tournees.ts'

/**
 * Où en est la tournée du courrier (ADR 044), en tête des écrans du courrier :
 * tant qu'elle est ouverte, rien n'est parti vers les domiciliés. L'état se
 * lit au texte et à l'icône, jamais à la seule couleur.
 *
 * Une fois la tournée du jour terminée (`dayReport`), plus de « Pas de
 * courrier aujourd'hui ? » (ADR 079) : les domiciliés ont été prévenus, le
 * courrier arrivé depuis ouvre une nouvelle tournée.
 */
export function BatchBanner({
  batch,
  dayReport,
  timeZone,
}: {
  batch: OpenBatch | undefined
  dayReport: DayReport | undefined
  timeZone: string
}) {
  if (!batch && dayReport) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white px-4 py-3 text-sm">
        <p className="flex items-center gap-2 text-muted-foreground">
          <CheckIcon size={20} className="shrink-0 text-primary" />
          <span>
            Tournée du jour terminée à <span className="tabular">{formatTime(dayReport.closedAt, timeZone)}</span>
            {dayReport.closedByName && ` par ${dayReport.closedByName}`} : les domiciliés ont été prévenus.
          </span>
        </p>
        <Link
          href="/courrier/tournee/saisie"
          className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Du courrier arrive encore ? Le saisir
        </Link>
      </div>
    )
  }
  if (!batch) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white px-4 py-3 text-sm">
        <p className="flex items-center gap-2 text-muted-foreground">
          <MailIcon size={20} className="shrink-0" />
          Aucune tournée en cours : le premier courrier enregistré l’ouvre.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/courrier/tournee"
            className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Pas de courrier aujourd’hui ?
          </Link>
          <Link
            href="/courrier/tournee/saisie"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Saisir le courrier du jour
          </Link>
        </div>
      </div>
    )
  }
  const count = batch.items.length
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <ClockIcon size={20} className="mt-0.5 shrink-0 text-primary" />
        <div>
          <p className="font-medium">
            Tournée en cours depuis {formatTime(batch.openedAt, timeZone)} :{' '}
            {count === 0 ? (
              'aucun courrier pour l’instant'
            ) : (
              <span className="tabular">
                {count} courrier{count > 1 ? 's' : ''} pour {batch.clientCount} entreprise
                {batch.clientCount > 1 ? 's' : ''}
              </span>
            )}
          </p>
          <p className="text-muted-foreground">
            Les domiciliés ne sont prévenus qu’à la fin de la tournée, un message chacun.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/courrier/tournee/saisie"
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Saisir d’autres plis
        </Link>
        <Link
          href="/courrier/tournee"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Terminer la tournée
        </Link>
      </div>
    </div>
  )
}
