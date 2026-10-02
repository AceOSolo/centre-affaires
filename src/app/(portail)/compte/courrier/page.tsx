import Link from 'next/link'

import { ArrowRightIcon, ClockIcon, MailIcon, MailOpenIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import {
  listRequestsForAccounts,
  searchMailForAccounts,
  type ClientMailCard,
} from '../../../../modules/courrier/demandes-queries.ts'
import {
  CLIENT_MAIL_PAGE_SIZE,
  clientMailQuery,
  clientMailStateLabels,
  clientMailStates,
  clientRequestOptions,
  pageCount,
  pendingRequestStatuses,
  readClientMailFilters,
} from '../../../../modules/courrier/demandes-regles.ts'
import { EnvelopeThumbnail } from '../../../../modules/courrier/enveloppe.tsx'
import { mailKindIcons, SendIcon } from '../../../../modules/courrier/icones.tsx'
import {
  mailKindLabels,
  mailRequestKindLabels,
  mailRequestStatusClientLabels,
  mailStatusClientLabels,
  mailStatusStyles,
} from '../../../../modules/courrier/labels.ts'
import { MailboxRequest } from '../../../../modules/courrier/mailbox-request.tsx'
import { mailKinds, type MailStatus } from '../../../../modules/courrier/schema.ts'

export const metadata = { title: 'Ma boîte aux lettres' }

const statusIcons: Record<MailStatus, typeof MailIcon> = {
  received: MailIcon,
  opening_requested: ClockIcon,
  opened: MailOpenIcon,
}

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 sm:text-sm'

/**
 * Boîte aux lettres de l'entreprise domiciliée (R21).
 *
 * Mobile d'abord : on la consulte au téléphone, entre deux rendez-vous. Une
 * carte par pli, avec la vignette de l'enveloppe et le type de pli ; les
 * actions en pleine largeur, à 44 px. Tout l'historique reste accessible,
 * filtré par type, période et état, page par page.
 */
export default async function BoiteAuxLettresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const { page, ...filters } = readClientMailFilters(await searchParams)
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const [mail, pending] = await Promise.all([
    searchMailForAccounts(accounts, filters, { number: page, size: CLIENT_MAIL_PAGE_SIZE }, timeZone),
    listRequestsForAccounts(accounts, { statuses: pendingRequestStatuses }, { number: 1, size: 1 }),
  ])
  const retention = tenant.mailScanRetentionMonths
  const several = accounts.length > 1
  const pages = pageCount(mail.total, CLIENT_MAIL_PAGE_SIZE)
  const filtered = Boolean(filters.kind || filters.from || filters.to || filters.state)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Ma boîte aux lettres
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Le courrier reçu au centre à votre nom. Pour chaque pli, demandez son ouverture et sa
          numérisation, une nouvelle numérisation, ou sa réexpédition.
        </p>
        {/* Transparence RGPD : la personne sait combien de temps ses documents restent. */}
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les numérisations sont conservées {retention} mois, puis effacées. Téléchargez celles
          que vous souhaitez garder.
        </p>
        <p className="mt-3">
          <Link
            href="/compte/courrier/demandes"
            className="inline-flex min-h-11 items-center gap-2 font-medium text-primary underline-offset-2 hover:underline"
          >
            Suivre mes demandes
            {pending.total > 0 && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-sm tabular">
                {pending.total} en cours
              </span>
            )}
            <ArrowRightIcon size={20} />
          </Link>
        </p>
      </div>

      {/* Formulaire GET : les filtres restent dans l'URL, la page se partage et se recharge. */}
      <form className="grid max-w-3xl gap-3 rounded-lg border border-border bg-muted p-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filtrer le courrier">
        <div>
          <label htmlFor="type" className="block text-sm font-medium">
            Type de pli
          </label>
          <select id="type" name="type" defaultValue={filters.kind ?? ''} className={fieldClass}>
            <option value="">Tous</option>
            {mailKinds.map((kind) => (
              <option key={kind} value={kind}>
                {mailKindLabels[kind]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="etat" className="block text-sm font-medium">
            État
          </label>
          <select id="etat" name="etat" defaultValue={filters.state ?? ''} className={fieldClass}>
            <option value="">Tous</option>
            {clientMailStates.map((state) => (
              <option key={state} value={state}>
                {clientMailStateLabels[state]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="du" className="block text-sm font-medium">
            Reçu à partir du
          </label>
          <input id="du" name="du" type="date" defaultValue={filters.from ?? ''} className={`${fieldClass} tabular`} />
        </div>
        <div>
          <label htmlFor="au" className="block text-sm font-medium">
            Jusqu’au
          </label>
          <input id="au" name="au" type="date" defaultValue={filters.to ?? ''} className={`${fieldClass} tabular`} />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center lg:col-span-4">
          <button
            type="submit"
            className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Filtrer
          </button>
          {filtered && (
            <Link
              href="/compte/courrier"
              className="inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              Effacer les filtres
            </Link>
          )}
        </div>
      </form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {mail.total === 0
          ? 'Aucun pli.'
          : `${mail.total} pli${mail.total > 1 ? 's' : ''}${filtered ? ' correspondant aux filtres' : ''}${pages > 1 ? ` — page ${Math.min(page, pages)} sur ${pages}` : ''}.`}
      </p>

      {mail.rows.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <MailIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            {filtered
              ? 'Aucun pli ne correspond à ces filtres. Élargissez la période ou effacez les filtres.'
              : 'Aucun courrier pour l’instant. Chaque pli reçu au centre à votre nom apparaîtra ici.'}
          </p>
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-4">
          {mail.rows.map((item) => (
            <li key={item.id}>
              <MailCard item={item} timeZone={timeZone} showClient={several} />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages du courrier" className="flex max-w-3xl flex-wrap items-center justify-between gap-2">
          {page > 1 ? (
            <Link
              href={`/compte/courrier${clientMailQuery(filters, page - 1)}`}
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted"
            >
              ← Plus récents
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground tabular">
            Page {Math.min(page, pages)} sur {pages}
          </span>
          {page < pages ? (
            <Link
              href={`/compte/courrier${clientMailQuery(filters, page + 1)}`}
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted"
            >
              Plus anciens →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  )
}

function MailCard({ item, timeZone, showClient }: { item: ClientMailCard; timeZone: string; showClient: boolean }) {
  const StatusIcon = statusIcons[item.status]
  const KindIcon = mailKindIcons[item.kind]
  const options = clientRequestOptions({ ...item, forwarded: item.forwardedAt !== null })
  const pendingOpening = item.pendingRequests.find((request) => request.kind === 'open_and_scan')
  const otherPending = item.pendingRequests.filter((request) => request.kind !== 'open_and_scan')
  const linkLabel = options.scan || options.forward ? 'Numériser, réexpédier, suivre' : 'Détails et suivi'

  return (
    <article aria-labelledby={`pli-${item.id}`} className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5">
      <div className="flex gap-4">
        <EnvelopeThumbnail {...item} timeZone={timeZone} size="small" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
            {item.forwardedAt ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground">
                <SendIcon size={16} />
                Réexpédié
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${mailStatusStyles[item.status]}`}>
                <StatusIcon size={16} />
                {mailStatusClientLabels[item.status]}
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <KindIcon size={16} className="text-primary" />
              {mailKindLabels[item.kind]}
            </span>
            {showClient && <span className="text-muted-foreground">· {item.clientName}</span>}
          </div>
          <h2 id={`pli-${item.id}`} className="mt-1 truncate text-base font-semibold">
            {item.sender ?? 'Expéditeur non précisé'}
          </h2>
          <p className="text-sm text-muted-foreground tabular">Reçu le {formatDateTime(item.receivedAt, timeZone)}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-sm text-muted-foreground tabular">
        {item.status === 'opening_requested' && item.openingRequestedAt && (
          <p>
            Ouverture demandée le {formatDateTime(item.openingRequestedAt, timeZone)}. La numérisation
            apparaîtra ici.
          </p>
        )}
        {item.openedAt && (
          <p>
            Ouvert le {formatDateTime(item.openedAt, timeZone)}
            {item.contentScanCount > 1 && ` · ${item.contentScanCount} numérisations`}
            {!item.contentScanId && ' — numérisation effacée au terme de sa durée de conservation'}
          </p>
        )}
        {item.forwardedAt && <p>Réexpédié le {formatDateTime(item.forwardedAt, timeZone)}.</p>}
        {otherPending.map((request) => (
          <p key={request.id}>
            {mailRequestKindLabels[request.kind]} : {mailRequestStatusClientLabels[request.status].toLowerCase()}.
          </p>
        ))}
      </div>

      {item.note && <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">{item.note}</p>}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        {item.contentScanId && (
          <a
            href={`/compte/scans/${item.contentScanId}`}
            className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <MailOpenIcon size={20} />
            Lire le courrier
          </a>
        )}
        {/* Une seule position pour les deux modes : le composant survit au
            passage de l'un à l'autre, et son message de confirmation reste
            annoncé. */}
        {(options.open_and_scan || pendingOpening?.status === 'requested') && (
          <MailboxRequest mailItemId={item.id} mode={options.open_and_scan ? 'request' : 'cancel'} />
        )}
        <Link
          href={`/compte/courrier/${item.id}`}
          aria-label={`${linkLabel} — pli de ${item.sender ?? 'expéditeur non précisé'} reçu le ${formatDateTime(item.receivedAt, timeZone)}`}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted"
        >
          {linkLabel}
          <ArrowRightIcon size={20} />
        </Link>
      </div>
    </article>
  )
}
