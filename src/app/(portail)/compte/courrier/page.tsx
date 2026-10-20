import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { ArrowRightIcon, CheckIcon, ClockIcon, MailIcon, MailOpenIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import {
  announceMailActs,
  announcePagePricing,
  listRequestsForAccounts,
  searchMailForAccounts,
  type ClientMailCard,
} from '../../../../modules/courrier/demandes-queries.ts'
import {
  CLIENT_MAIL_PAGE_SIZE,
  clientMailQuery,
  clientMailStateLabels,
  clientMailStates,
  type ClientMailFilters,
  clientRequestOptions,
  openingAnnouncementText,
  pageCount,
  pendingRequestStatuses,
  readClientMailFilters,
} from '../../../../modules/courrier/demandes-regles.ts'
import { EnvelopeThumbnail } from '../../../../modules/courrier/enveloppe.tsx'
import { mailKindIcons, SendIcon } from '../../../../modules/courrier/icones.tsx'
import {
  mailCategoryLabels,
  mailKindLabels,
  mailRequestKindLabels,
  mailRequestStatusClientLabels,
  mailStatusClientLabels,
  mailStatusStyles,
} from '../../../../modules/courrier/labels.ts'
import { MailboxRequest } from '../../../../modules/courrier/mailbox-request.tsx'
import { mailFolderCounts, type MailFolderCounts } from '../../../../modules/courrier/classement.ts'
import { SELECTION_FORM_ID, SelectionBar } from '../../../../modules/courrier/classement-forms.tsx'
import {
  classificationDoneMessage,
  followUpFilters,
  followUpLabels,
} from '../../../../modules/courrier/classement-regles.ts'
import { mailCategories } from '../../../../modules/courrier/categories.ts'
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
  const [mail, pending, folders] = await Promise.all([
    searchMailForAccounts(accounts, filters, { number: page, size: CLIENT_MAIL_PAGE_SIZE }, timeZone),
    listRequestsForAccounts(accounts, { statuses: pendingRequestStatuses }, { number: 1, size: 1 }),
    mailFolderCounts(accounts),
  ])
  // Prix d'une ouverture, annoncé sur chaque pli qui peut en recevoir la
  // demande : la même source que la fiche du pli (ADR 037, 044).
  const openable = mail.rows.some(
    (item) => clientRequestOptions({ ...item, forwarded: item.forwardedAt !== null }).open_and_scan,
  )
  const [announcements, pagePricing] = openable
    ? await Promise.all([announceMailActs(accounts, timeZone), announcePagePricing(accounts, timeZone)])
    : [new Map(), new Map()]
  const openingAnnouncement = (clientId: string) =>
    openingAnnouncementText(announcements.get(clientId)?.open_and_scan, pagePricing.get(clientId) ?? null)
  const params = await searchParams
  const done = typeof params.classe === 'string' ? /^([a-z-]+)-(\d+)$/.exec(params.classe) : null
  const retention = tenant.mailScanRetentionMonths
  const several = accounts.length > 1
  const pages = pageCount(mail.total, CLIENT_MAIL_PAGE_SIZE)
  const filtered = Boolean(
    filters.kind || filters.from || filters.to || filters.state || filters.category || filters.followUp || filters.tag,
  )

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

      {done && (
        <FlashNotice key={String(params.classe)}>{classificationDoneMessage(done[1], Number(done[2]))}</FlashNotice>
      )}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <MailFolders folders={folders} filters={filters} />
      <div className="flex min-w-0 flex-col gap-6">
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
        {/* Les rubriques choisies à gauche restent quand on filtre. */}
        {filters.category && <input type="hidden" name="categorie" value={filters.category} />}
        {filters.followUp && <input type="hidden" name="suivi" value={filters.followUp} />}
        {filters.tag && <input type="hidden" name="etiquette" value={filters.tag} />}
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
        <>
          <SelectionBar
            returnQuery={clientMailQuery(filters, page)}
            knownTags={folders.tags.map((entry) => entry.tag)}
          />
          <ul className="flex max-w-3xl flex-col gap-4">
            {mail.rows.map((item) => (
              <li key={item.id}>
                <MailCard
                  item={item}
                  timeZone={timeZone}
                  showClient={several}
                  openingAnnouncement={openingAnnouncement(item.clientId)}
                />
              </li>
            ))}
          </ul>
        </>
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
      </div>
    </div>
  )
}

/**
 * Rubriques de la boîte aux lettres (ADR 044), comme dans un espace bancaire :
 * le suivi (non lus, à traiter, traités), les catégories et les étiquettes de
 * la personne, chacune avec son nombre de plis. Liens simples : la rubrique
 * est dans l'URL, la page se partage et se recharge.
 */
function MailFolders({ folders, filters }: { folders: MailFolderCounts; filters: ClientMailFilters }) {
  const base = { kind: filters.kind, from: filters.from, to: filters.to, state: filters.state }
  const link = (next: ClientMailFilters) => `/compte/courrier${clientMailQuery({ ...base, ...next })}`
  const all = !filters.category && !filters.followUp && !filters.tag
  const followUpCount = { 'non-lus': folders.unread, 'a-traiter': folders.toHandle, traites: folders.handled }
  const categories = [...mailCategories, 'non-classe' as const].filter(
    (category) => folders.byCategory[category].total > 0 || filters.category === category,
  )

  return (
    <nav aria-label="Rubriques du courrier" className="flex flex-col gap-4 text-sm">
      <FolderGroup title="Suivi">
        <FolderLink href={link({})} active={all} label="Tout le courrier" count={folders.total} />
        {followUpFilters.map((followUp) => (
          <FolderLink
            key={followUp}
            href={link({ category: filters.category, followUp })}
            active={filters.followUp === followUp}
            label={followUpLabels[followUp]}
            count={followUpCount[followUp]}
          />
        ))}
      </FolderGroup>
      <FolderGroup title="Catégories">
        {categories.length === 0 ? (
          <li className="px-3 text-muted-foreground">Rangez vos courriers : cochez-les, puis « Classer ».</li>
        ) : (
          categories.map((category) => (
            <FolderLink
              key={category}
              href={link({ category, followUp: filters.followUp })}
              active={filters.category === category}
              label={category === 'non-classe' ? 'Non classé' : mailCategoryLabels[category]}
              count={folders.byCategory[category].total}
              unread={folders.byCategory[category].unread}
            />
          ))
        )}
      </FolderGroup>
      {folders.tags.length > 0 && (
        <FolderGroup title="Étiquettes">
          {folders.tags.map((entry) => (
            <FolderLink
              key={entry.tag}
              href={link({ tag: entry.tag })}
              active={filters.tag === entry.tag}
              label={entry.tag}
              count={entry.count}
            />
          ))}
        </FolderGroup>
      )}
    </nav>
  )
}

function FolderGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="mt-1 flex flex-wrap gap-1 lg:flex-col">{children}</ul>
    </div>
  )
}

function FolderLink({
  href,
  active,
  label,
  count,
  unread = 0,
}: {
  href: string
  active: boolean
  label: string
  count: number
  unread?: number
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={`flex min-h-11 items-center justify-between gap-3 rounded-md px-3 transition-colors ${
          active ? 'bg-primary font-medium text-primary-foreground' : 'text-foreground hover:bg-muted'
        }`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className="tabular">
          {count}
          {unread > 0 && <span className="sr-only">, dont {unread} non lu{unread > 1 ? 's' : ''}</span>}
        </span>
      </Link>
    </li>
  )
}

function MailCard({
  item,
  timeZone,
  showClient,
  openingAnnouncement,
}: {
  item: ClientMailCard
  timeZone: string
  showClient: boolean
  openingAnnouncement: string
}) {
  const StatusIcon = statusIcons[item.status]
  const KindIcon = mailKindIcons[item.kind]
  const options = clientRequestOptions({ ...item, forwarded: item.forwardedAt !== null })
  const pendingOpening = item.pendingRequests.find((request) => request.kind === 'open_and_scan')
  const otherPending = item.pendingRequests.filter((request) => request.kind !== 'open_and_scan')
  const linkLabel = options.scan || options.forward ? 'Numériser, réexpédier, suivre' : 'Détails et suivi'
  const unread = item.classification.readAt === null

  return (
    <article aria-labelledby={`pli-${item.id}`} className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="ids"
            value={item.id}
            form={SELECTION_FORM_ID}
            className="size-5"
            aria-describedby={`pli-${item.id}`}
          />
          Sélectionner
        </label>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Lu et traité se lisent au libellé et à l'icône, pas à la seule couleur. */}
          {unread && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 font-semibold text-primary">
              <MailIcon size={16} />
              Non lu
            </span>
          )}
          {item.classification.handledAt && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-medium">
              <CheckIcon size={16} className="text-primary" />
              Traité
            </span>
          )}
        </div>
      </div>
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
          <h2 id={`pli-${item.id}`} className={`mt-1 truncate text-base ${unread ? 'font-bold' : 'font-semibold'}`}>
            {item.sender ?? 'Expéditeur non précisé'}
          </h2>
          <p className="text-sm text-muted-foreground tabular">Reçu le {formatDateTime(item.receivedAt, timeZone)}</p>
          {(item.classification.category || item.classification.tags.length > 0) && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {item.classification.category && (
                <span className="font-medium text-primary">{mailCategoryLabels[item.classification.category]}</span>
              )}
              {item.classification.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-foreground">
                  {tag}
                </span>
              ))}
            </p>
          )}
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
          <MailboxRequest
            mailItemId={item.id}
            mode={options.open_and_scan ? 'request' : 'cancel'}
            announcement={openingAnnouncement}
          />
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
