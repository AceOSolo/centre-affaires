import Link from 'next/link'

import { ClockIcon, MailIcon } from '../../components/ui/icons.tsx'
import { formatTime } from '../../lib/dates.ts'
import type { OpenBatch } from './tournees.ts'

/**
 * Où en est la tournée du courrier (ADR 044), en tête des écrans du courrier :
 * tant qu'elle est ouverte, rien n'est parti vers les domiciliés. L'état se
 * lit au texte et à l'icône, jamais à la seule couleur.
 */
export function BatchBanner({ batch, timeZone }: { batch: OpenBatch | undefined; timeZone: string }) {
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
            <span className="tabular">
              {count} courrier{count > 1 ? 's' : ''} pour {batch.clientCount} entreprise
              {batch.clientCount > 1 ? 's' : ''}
            </span>
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
