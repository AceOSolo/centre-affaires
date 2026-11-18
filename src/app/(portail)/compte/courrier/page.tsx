import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { ArrowRightIcon, CheckIcon, ClockIcon, MailIcon, MailOpenIcon, MapPinIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { withReturn } from '../../../../lib/redirection.ts'
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
  MAX_SENDER_FILTER_LENGTH,
  openingAnnouncementText,
  pageCount,
  pendingRequestStatuses,
  readClientMailFilters,
} from '../../../../modules/courrier/demandes-regles.ts'
import { EnvelopeThumbnail } from '../../../../modules/courrier/enveloppe.tsx'
import { mailKindIcons, SendIcon } from '../../../../modules/courrier/icones.tsx'
import { ArchiveIcon, ChevronDownIcon, FilterIcon } from '../../../../modules/courrier/icones-client.tsx'
import {
  mailKindLabels,
  mailRequestKindLabels,
  mailRequestStatusClientLabels,
  mailStatusClientLabels,
  mailStatusStyles,
} from '../../../../modules/courrier/labels.ts'
import { MailboxRequest } from '../../../../modules/courrier/mailbox-request.tsx'
import { listMailSenders, mailFolderCounts, type MailFolderCounts } from '../../../../modules/courrier/classement.ts'
import { MailCardClassify, MailCardReadToggle, MailIgnoreButton } from '../../../../modules/courrier/classement-carte.tsx'
import { SelectionBar, type CategoryOption } from '../../../../modules/courrier/classement-forms.tsx'
import { quickButtonClass, SELECTION_FORM_ID } from '../../../../modules/courrier/classement-ui.ts'
import {
  classificationDoneMessage,
  followUpFilters,
  followUpLabels,
  type CategoryFilter,
} from '../../../../modules/courrier/classement-regles.ts'
import { loadCategoryLists } from '../../../../modules/courrier/categories-reglages.ts'
import {
  categoryLabel,
  classifiableCategories,
  type CategoryEntry,
} from '../../../../modules/courrier/categories-reglages-regles.ts'
import { mailKinds, type MailCategory, type MailStatus } from '../../../../modules/courrier/schema.ts'

export const metadata = { title: 'Ma boîte aux lettres' }

const statusIcons: Record<MailStatus, typeof MailIcon> = {
  received: MailIcon,
  opening_requested: ClockIcon,
  opened: MailOpenIcon,
}

/** En-tête d'un bloc repliable : cible de 44 px, chevron qui dit l'état. */
const foldSummaryClass =
  'flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 text-sm font-medium text-primary [&::-webkit-details-marker]:hidden'
const foldChevronClass = 'shrink-0 transition-transform duration-150 ease-out group-open:rotate-180 motion-reduce:transition-none'

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 sm:text-sm'

/** Une catégorie de la liste, en option de formulaire ; le nom porte l'entreprise si le compte en a plusieurs. */
const toOption = (entry: CategoryEntry, company?: string): CategoryOption => ({
  id: entry.key,
  name: company ? `${entry.name} (${company})` : entry.name,
})

/**
 * Boîte aux lettres de l'entreprise domiciliée (R21, ADR 044, ADR 078).
 *
 * Mobile d'abord : on la consulte au téléphone, entre deux rendez-vous. Une
 * carte par pli, avec la vignette de l'enveloppe et le type de pli. Sur chaque
 * carte, sans ouvrir la fiche : la catégorie, « Marquer comme lu » et
 * « Ignorer », au même rang ; les demandes au centre (ouverture,
 * numérisation, envoi) dans un menu compact, l'action complète sur la fiche.
 * Filtres combinables, gardés dans l'adresse : période, suivi, catégorie,
 * type, état, expéditeur.
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
  const [mail, pending, folders, lists, senders] = await Promise.all([
    searchMailForAccounts(accounts, filters, { number: page, size: CLIENT_MAIL_PAGE_SIZE }, timeZone),
    listRequestsForAccounts(accounts, { statuses: pendingRequestStatuses }, { number: 1, size: 1 }),
    mailFolderCounts(accounts),
    loadCategoryLists(accounts),
    listMailSenders(accounts),
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
  // L'adresse de cette vue, filtres et page compris : les pages ouvertes
  // d'ici y ramènent par leur lien « ← … » (`?retour=`).
  const listQuery = clientMailQuery(filters, page)
  const here = listQuery ? `/compte/courrier${listQuery}` : null
  const filtered = Boolean(
    filters.kind ||
      filters.from ||
      filters.to ||
      filters.state ||
      filters.category ||
      filters.followUp ||
      filters.tag ||
      filters.sender,
  )

  // Les catégories proposées, sous les noms et dans l'ordre de la personne
  // (ADR 078) : la liste de sa première entreprise ; les siennes, de chaque
  // entreprise, le nom de l'entreprise en plus quand le compte en a plusieurs.
  const firstList = lists.get(accounts[0]?.clientId ?? '') ?? []
  const ownEntries = accounts.flatMap((account) =>
    (lists.get(account.clientId) ?? [])
      .filter((entry) => entry.kind === 'perso')
      .map((entry) => ({ entry, company: several ? account.clientName : undefined })),
  )
  const proposedOptions = classifiableCategories(firstList.filter((entry) => entry.kind === 'proposee')).map((entry) =>
    toOption(entry),
  )
  const customOptions = ownEntries
    .filter(({ entry }) => !entry.hidden)
    .map(({ entry, company }) => toOption(entry, company))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Ma boîte aux lettres
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Le courrier reçu au centre à votre nom. Rangez-le, marquez-le comme lu ou ignorez-le ; pour
          chaque pli, demandez son ouverture, une numérisation ou son envoi.
        </p>
        {/* Transparence RGPD : la personne sait combien de temps ses documents restent. */}
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les numérisations sont conservées {retention} mois, puis effacées. Téléchargez celles
          que vous souhaitez garder.
        </p>
        <ul className="mt-3 flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6">
          <li>
            <Link
              href={withReturn('/compte/courrier/demandes', here)}
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
          </li>
          <li>
            <Link
              href={withReturn('/compte/courrier/adresses', here)}
              className="inline-flex min-h-11 items-center gap-2 font-medium text-primary underline-offset-2 hover:underline"
            >
              <MapPinIcon size={20} />
              Mes adresses
            </Link>
          </li>
        </ul>
      </div>

      {done && (
        <FlashNotice key={String(params.classe)}>{classificationDoneMessage(done[1], Number(done[2]))}</FlashNotice>
      )}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Sur ordinateur, les rubriques restent sous la main au défilement,
          sous l'en-tête collant du site ; au téléphone, elles restent en tête. */}
      <div className="lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain">
      <MailFolders
        here={here}
        folders={folders}
        filters={filters}
        entries={[
          ...firstList,
          ...ownEntries.filter(({ entry }) => !firstList.includes(entry)).map(({ entry }) => entry),
        ]}
        companyOf={several ? new Map(ownEntries.map(({ entry, company }) => [entry.key, company ?? ''])) : undefined}
      />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
      {/* Replié par défaut, ouvert quand un filtre est actif (recette du 17/11).
          Formulaire GET : les filtres restent dans l'URL, la page se partage et se recharge. */}
      <details open={filtered} className="group max-w-3xl rounded-lg border border-border bg-muted">
        <summary className={foldSummaryClass}>
          <span className="inline-flex items-center gap-2">
            <FilterIcon size={20} />
            Filtrer le courrier
            {filtered && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">filtres actifs</span>}
          </span>
          <ChevronDownIcon size={20} className={foldChevronClass} />
        </summary>
      <form className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Filtrer le courrier">
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
        <div>
          <label htmlFor="suivi" className="block text-sm font-medium">
            Suivi
          </label>
          <select id="suivi" name="suivi" defaultValue={filters.followUp ?? ''} className={fieldClass}>
            <option value="">Tous, sauf ignorés</option>
            {followUpFilters.map((followUp) => (
              <option key={followUp} value={followUp}>
                {followUpLabels[followUp]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="categorie-filtre" className="block text-sm font-medium">
            Catégorie
          </label>
          <select id="categorie-filtre" name="categorie" defaultValue={filters.category ?? ''} className={fieldClass}>
            <option value="">Toutes</option>
            {firstList
              .filter((entry) => entry.kind === 'proposee')
              .map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            {ownEntries.length > 0 && (
              <optgroup label="Mes catégories">
                {ownEntries.map(({ entry, company }) => (
                  <option key={entry.key} value={entry.key}>
                    {company ? `${entry.name} (${company})` : entry.name}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="non-classe">Non classé</option>
          </select>
        </div>
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
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor="expediteur" className="block text-sm font-medium">
            Expéditeur
          </label>
          <input
            id="expediteur"
            name="expediteur"
            list="expediteurs-connus"
            maxLength={MAX_SENDER_FILTER_LENGTH}
            autoComplete="off"
            defaultValue={filters.sender ?? ''}
            aria-describedby="expediteur-aide"
            className={fieldClass}
          />
          <datalist id="expediteurs-connus">
            {senders.map((sender) => (
              <option key={sender} value={sender} />
            ))}
          </datalist>
          <p id="expediteur-aide" className="mt-1 text-sm text-muted-foreground">
            Tout ou partie du nom : « impots » trouve « impots.gouv ».
          </p>
        </div>
        {/* L'étiquette choisie à gauche reste quand on filtre. */}
        {filters.tag && <input type="hidden" name="etiquette" value={filters.tag} />}
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center lg:col-span-3">
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
      </details>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {mail.total === 0
          ? 'Aucun pli.'
          : `${mail.total} pli${mail.total > 1 ? 's' : ''}${filtered ? ' correspondant aux filtres' : ''}${pages > 1 ? ` — page ${Math.min(page, pages)} sur ${pages}` : ''}.`}
        {!filters.followUp && folders.ignored > 0 && (
          <>
            {' '}
            <Link
              href={`/compte/courrier${clientMailQuery({ ...filters, followUp: 'ignores' })}`}
              className="underline underline-offset-2 hover:text-primary"
            >
              {folders.ignored} ignoré{folders.ignored > 1 ? 's' : ''}, hors de cette liste
            </Link>
            .
          </>
        )}
      </p>

      {mail.rows.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <MailIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            {filters.followUp === 'ignores'
              ? 'Aucun courrier ignoré. « Ignorer », sur un courrier, le retire de la liste sans rien demander au centre.'
              : filtered
                ? 'Aucun pli ne correspond à ces filtres. Élargissez la période ou effacez les filtres.'
                : 'Aucun courrier pour l’instant. Chaque pli reçu au centre à votre nom apparaîtra ici.'}
          </p>
        </div>
      ) : (
        <>
          {/* Les gestes groupés, repliés par défaut : on coche d'abord, on agit ensuite. */}
          <details className="group max-w-3xl rounded-lg border border-border bg-white">
            <summary className={foldSummaryClass}>
              <span>Actions sur les courriers cochés</span>
              <ChevronDownIcon size={20} className={foldChevronClass} />
            </summary>
            <div className="border-t border-border">
              {/* Le cadre est celui du bloc repliable. */}
              <SelectionBar
                returnQuery={listQuery}
                knownTags={folders.tags.map((entry) => entry.tag)}
                proposedCategories={proposedOptions}
                customCategories={customOptions}
                showingIgnored={filters.followUp === 'ignores'}
              />
            </div>
          </details>
          <ul className="flex max-w-3xl flex-col gap-4">
            {mail.rows.map((item) => {
              const list = lists.get(item.clientId) ?? []
              const current = item.classification.customCategoryId ?? item.classification.category ?? ''
              const classifiable = classifiableCategories(list, current)
              return (
                <li key={item.id}>
                  <MailCard
                    item={item}
                    timeZone={timeZone}
                    showClient={several}
                    openingAnnouncement={openingAnnouncement(item.clientId)}
                    category={categoryLabel(item.classification, list)}
                    current={current}
                    proposed={classifiable.filter((entry) => entry.kind === 'proposee').map((entry) => toOption(entry))}
                    custom={classifiable.filter((entry) => entry.kind === 'perso').map((entry) => toOption(entry))}
                    returnQuery={listQuery}
                    here={here}
                  />
                </li>
              )
            })}
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
 * le suivi (non lus, à traiter, traités, ignorés), les catégories — sous les
 * noms et dans l'ordre de la personne (ADR 078) — et les étiquettes, chacune
 * avec son nombre de plis. Liens simples : la rubrique est dans l'URL, avec
 * les autres filtres, la page se partage et se recharge.
 */
function MailFolders({
  here,
  folders,
  filters,
  entries,
  companyOf,
}: {
  /** Adresse de la vue en cours, pour le retour de « Gérer mes catégories ». */
  here: string | null
  folders: MailFolderCounts
  filters: ClientMailFilters
  /** La liste de la personne : catégories proposées et les siennes, dans son ordre. */
  entries: readonly CategoryEntry[]
  /** Plusieurs entreprises : chaque catégorie personnelle dit la sienne. */
  companyOf?: Map<string, string>
}) {
  const base = { kind: filters.kind, from: filters.from, to: filters.to, state: filters.state, sender: filters.sender }
  const link = (next: ClientMailFilters) => `/compte/courrier${clientMailQuery({ ...base, ...next })}`
  const all = !filters.category && !filters.followUp && !filters.tag
  const followUpCount = {
    'non-lus': folders.unread,
    'a-traiter': folders.toHandle,
    traites: folders.handled,
    ignores: folders.ignored,
  }
  const customCounts = new Map(folders.custom.map((entry) => [entry.id, entry]))
  const countOf = (entry: CategoryEntry) =>
    entry.kind === 'perso'
      ? (customCounts.get(entry.key) ?? { total: 0, unread: 0 })
      : folders.byCategory[entry.key as MailCategory]
  // Une catégorie proposée n'apparaît que si elle range des plis ; une
  // catégorie à soi, toujours, sauf masquée et vide (ADR 060, ADR 078).
  const shown = entries.filter((entry) => {
    const count = countOf(entry)?.total ?? 0
    if (filters.category === entry.key || count > 0) return true
    return entry.kind === 'perso' && !entry.hidden
  })
  const unclassified = folders.byCategory['non-classe']

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
        {shown.length === 0 && unclassified.total === 0 ? (
          <li className="px-3 text-muted-foreground">Rangez vos courriers : choisissez leur catégorie dans la liste.</li>
        ) : (
          <>
            {shown.map((entry) => {
              const count = countOf(entry) ?? { total: 0, unread: 0 }
              const company = companyOf?.get(entry.key)
              return (
                <FolderLink
                  key={entry.key}
                  href={link({ category: entry.key as CategoryFilter, followUp: filters.followUp })}
                  active={filters.category === entry.key}
                  label={company ? `${entry.name} (${company})` : entry.name}
                  count={count.total}
                  unread={count.unread}
                />
              )
            })}
            {(unclassified.total > 0 || filters.category === 'non-classe') && (
              <FolderLink
                href={link({ category: 'non-classe', followUp: filters.followUp })}
                active={filters.category === 'non-classe'}
                label="Non classé"
                count={unclassified.total}
                unread={unclassified.unread}
              />
            )}
          </>
        )}
        <li>
          <Link
            href={withReturn('/compte/courrier/categories', here)}
            className="flex min-h-11 items-center gap-2 rounded-md px-3 font-medium text-primary underline-offset-2 hover:underline"
          >
            Gérer mes catégories
          </Link>
        </li>
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
  category,
  current,
  proposed,
  custom,
  returnQuery,
  here,
}: {
  item: ClientMailCard
  timeZone: string
  showClient: boolean
  openingAnnouncement: string
  /** Nom de la catégorie du pli, sous le nom que la personne lui donne ; nul : non classé. */
  category: string | null
  /** Catégorie du pli, telle que la liste la choisit. */
  current: string
  proposed: CategoryOption[]
  custom: CategoryOption[]
  returnQuery: string
  /** Adresse de la liste, filtres et page compris : la fiche du pli y ramène. */
  here: string | null
}) {
  const StatusIcon = statusIcons[item.status]
  const KindIcon = mailKindIcons[item.kind]
  const options = clientRequestOptions({ ...item, forwarded: item.forwardedAt !== null })
  const pendingOpening = item.pendingRequests.find((request) => request.kind === 'open_and_scan')
  const otherPending = item.pendingRequests.filter((request) => request.kind !== 'open_and_scan')
  const opening = options.open_and_scan || pendingOpening?.status === 'requested'
  const unread = item.classification.readAt === null
  const ignored = item.classification.ignoredAt !== null
  const sender = item.sender ?? 'Expéditeur non précisé'
  const pliLabel = `pli de ${sender} reçu le ${formatDateTime(item.receivedAt, timeZone)}`
  const hasRequests = opening || options.scan || options.forward

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
          {/* Lu, traité et ignoré se lisent au libellé et à l'icône, pas à la seule couleur. */}
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
          {ignored && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
              <ArchiveIcon size={16} />
              Ignoré
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
          <h2 id={`pli-${item.id}`} className={`mt-1 text-base ${unread ? 'font-bold' : 'font-semibold'}`}>
            {/* La fiche du pli (numérisations, classement, suivi) s'ouvre par
                son expéditeur. Cible de 44 px, les marges négatives gardent la
                hauteur de la ligne. */}
            <Link
              href={withReturn(`/compte/courrier/${item.id}`, here)}
              className="relative -my-2.5 flex min-h-11 items-center underline-offset-2 hover:underline"
            >
              <span className="truncate">{sender}</span>
            </Link>
          </h2>
          <p className="text-sm text-muted-foreground tabular">Reçu le {formatDateTime(item.receivedAt, timeZone)}</p>
          {(category || item.classification.tags.length > 0) && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {category && <span className="font-medium text-primary">{category}</span>}
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

      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <MailCardClassify
          mailItemId={item.id}
          clientId={item.clientId}
          current={current}
          proposed={proposed}
          custom={custom}
          pliLabel={pliLabel}
        />
        {/* Gestes au même rang : aucun ne prend le pas sur « Marquer comme lu ». */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          {item.contentScanId && (
            <a href={`/compte/scans/${item.contentScanId}`} className={`${quickButtonClass} min-h-11 w-full sm:w-auto`}>
              <MailOpenIcon size={20} />
              Lire le courrier
            </a>
          )}
          <MailCardReadToggle mailItemId={item.id} unread={unread} pliLabel={pliLabel} />
          <MailIgnoreButton mailItemId={item.id} ignored={ignored} pliLabel={pliLabel} returnQuery={returnQuery} />
        </div>
        {/* Les demandes au centre, repliées : un menu par pli, l'action complète sur la fiche. */}
        {hasRequests && (
          <details className="group rounded-md border border-border">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
              <span>
                Demander au centre<span className="sr-only"> — {pliLabel}</span>
              </span>
              <ChevronDownIcon size={20} className="transition-transform duration-150 ease-out group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="flex flex-col gap-3 border-t border-border p-3">
              {/* Une seule position pour les deux modes : le composant survit au
                  passage de l'un à l'autre, et son message de confirmation reste
                  annoncé. */}
              {opening && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Ouverture et numérisation</p>
                  <MailboxRequest
                    mailItemId={item.id}
                    mode={options.open_and_scan ? 'request' : 'cancel'}
                    announcement={openingAnnouncement}
                  />
                </div>
              )}
              {options.scan && (
                <Link
                  href={withReturn(`/compte/courrier/${item.id}?demande=numerisation#numerisation`, here)}
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  Demander une nouvelle numérisation…
                </Link>
              )}
              {/* L'envoi demande une adresse : la fiche du pli s'ouvre sur son formulaire. */}
              {options.forward && (
                <Link
                  href={withReturn(`/compte/courrier/${item.id}?demande=envoi#reexpedition`, here)}
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  <SendIcon size={20} />
                  Demander l’envoi…
                </Link>
              )}
            </div>
          </details>
        )}
      </div>
    </article>
  )
}
