import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { MailOpenIcon } from '../../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { ClientRequestCard } from '../../../../../modules/courrier/demande-carte.tsx'
import { ForwardRequestForm, ScanRequestForm } from '../../../../../modules/courrier/demandes-compte-forms.tsx'
import {
  announceMailActs,
  announcePagePricing,
  findMailForAccounts,
  previousForwardAddresses,
} from '../../../../../modules/courrier/demandes-queries.ts'
import {
  announcementText,
  clientRequestOptions,
  pagePricingText,
  countryName,
  forwardAddressLines,
  forwardCountries,
} from '../../../../../modules/courrier/demandes-regles.ts'
import { EnvelopeThumbnail } from '../../../../../modules/courrier/enveloppe.tsx'
import { mailKindIcons, SendIcon } from '../../../../../modules/courrier/icones.tsx'
import {
  mailCategoryLabels,
  mailKindLabels,
  mailStatusClientLabels,
  mailStatusStyles,
} from '../../../../../modules/courrier/labels.ts'
import { MailboxRequest } from '../../../../../modules/courrier/mailbox-request.tsx'
import { markUnreadAction } from '../../../../../modules/courrier/classement-actions.ts'
import { ClassificationForm } from '../../../../../modules/courrier/classement-forms.tsx'
import { mailFolderCounts, markMailRead } from '../../../../../modules/courrier/classement.ts'

export const metadata = { title: 'Courrier' }

/** Confirmations, après une demande déposée ou annulée (`?fait=`). */
const notices: Record<string, string> = {
  numerisation: 'Demande de numérisation envoyée. Le centre vous préviendra par courriel quand elle sera faite.',
  reexpedition:
    'Demande de réexpédition envoyée, à l’adresse indiquée. Le centre vous préviendra par courriel à l’envoi.',
  annulation: 'Demande annulée. Elle reste dans votre historique, à votre nom.',
}

/** « 1 page », « 12 pages ». */
const pagesLabel = (count: number) => `${count} page${count > 1 ? 's' : ''}`

const summaryClass =
  'flex min-h-11 cursor-pointer items-center rounded-md px-1 text-base font-semibold text-primary'

/**
 * Un pli et tout ce qui s'y rattache (R21, R24) : la photo de l'enveloppe, le
 * type de pli, chaque numérisation encore conservée, les demandes possibles —
 * ouverture, nouvelle numérisation, réexpédition, avec leur prix annoncé — et
 * le suivi daté de chaque demande, annulations comprises.
 */
export default async function PliPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string; classe?: string }>
}) {
  const { accounts } = await requireClientAccount()
  const [{ id }, { fait, classe }] = await Promise.all([params, searchParams])
  // Ouvrir la fiche, c'est lire le pli (ADR 044) : « lu » pour cette personne.
  await markMailRead(accounts, id)
  const [tenant, mail, folders] = await Promise.all([
    currentTenant(),
    findMailForAccounts(id, accounts),
    mailFolderCounts(accounts),
  ])
  if (!mail) notFound()
  const timeZone = tenant.timezone

  const options = clientRequestOptions({ ...mail, forwarded: mail.forwardedAt !== null })
  const own = accounts.filter((account) => account.clientId === mail.clientId)
  const [announcements, previous, pagePricing] = await Promise.all([
    announceMailActs(own, timeZone),
    options.forward ? previousForwardAddresses(accounts, mail.clientId) : Promise.resolve([]),
    options.open_and_scan ? announcePagePricing(own, timeZone) : Promise.resolve(new Map()),
  ])
  const pagesText = pagePricingText(pagePricing.get(mail.clientId) ?? null)
  const prices = announcements.get(mail.clientId)
  const announce = (kind: 'open_and_scan' | 'scan' | 'forward') =>
    prices ? announcementText(prices[kind]) : announcementText({ source: 'unpriced' })
  const contents = mail.scans.filter((scan) => scan.side === 'content')
  const KindIcon = mailKindIcons[mail.kind]
  const pendingOpening = mail.pendingRequests.find((request) => request.kind === 'open_and_scan')

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/compte/courrier"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          ← Ma boîte aux lettres
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {mail.forwardedAt ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground">
              <SendIcon size={16} />
              Réexpédié
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${mailStatusStyles[mail.status]}`}>
              {mailStatusClientLabels[mail.status]}
            </span>
          )}
          <span className="inline-flex items-center gap-1 font-medium">
            <KindIcon size={16} className="text-primary" />
            {mailKindLabels[mail.kind]}
          </span>
          {accounts.length > 1 && <span className="text-muted-foreground">· {mail.clientName}</span>}
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-primary">
          {mail.sender ?? 'Expéditeur non précisé'}
        </h1>
        <p className="text-sm text-muted-foreground tabular">Reçu le {formatDateTime(mail.receivedAt, timeZone)}</p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}
      {classe === 'enregistre' && <FlashNotice key="classe">Votre classement est enregistré.</FlashNotice>}

      <EnvelopeThumbnail {...mail} timeZone={timeZone} size="large" />

      {mail.note && <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">{mail.note}</p>}

      {mail.forwardedAt && (
        <p className="rounded-md border border-border bg-white px-4 py-3 text-sm">
          Ce courrier a été réexpédié le {formatDateTime(mail.forwardedAt, timeZone)} : il n’est plus au
          centre, aucune autre demande n’est possible.
        </p>
      )}

      <section aria-labelledby="numerisations" className="flex flex-col gap-3">
        <h2 id="numerisations" className="text-lg font-semibold">
          Numérisations
        </h2>
        {contents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {mail.openedAt
              ? 'Les numérisations de ce pli ont été effacées au terme de leur durée de conservation. Demandez-en une nouvelle si besoin.'
              : 'Ce pli n’est pas encore ouvert. Demandez son ouverture pour en recevoir ici la numérisation.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {contents.map((scan, index) => (
              <li key={scan.id}>
                <a
                  href={`/compte/scans/${scan.id}`}
                  className="press inline-flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-white px-4 py-2.5 text-sm font-medium text-primary hover:bg-muted sm:w-auto"
                >
                  <MailOpenIcon size={20} />
                  {index === 0 ? 'Contenu' : `Numérisation n° ${index + 1}`} — déposé le {formatDateTime(scan.createdAt, timeZone)}
                  {scan.pageCount !== null && ` · ${pagesLabel(scan.pageCount)}`}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="classement" className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="classement" className="text-lg font-semibold">
            Mon classement
          </h2>
          <p className="text-sm text-muted-foreground">
            {mail.classification.category
              ? mailCategoryLabels[mail.classification.category]
              : 'Non classé'}
            {' · '}
            {mail.classification.handledAt ? 'Traité' : 'À traiter'}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Rangez ce courrier comme dans un espace bancaire. Votre classement vous est propre : le centre
          et vos collègues ne le voient pas.
        </p>
        <ClassificationForm
          mailItemId={mail.id}
          classification={mail.classification}
          knownTags={folders.tags.map((entry) => entry.tag)}
        />
        <form action={markUnreadAction}>
          <input type="hidden" name="id" value={mail.id} />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            Marquer comme non lu et revenir à la boîte aux lettres
          </button>
        </form>
      </section>

      {(options.open_and_scan || options.scan || options.forward || pendingOpening?.status === 'requested') && (
        <section aria-labelledby="demander" className="flex flex-col gap-3">
          <h2 id="demander" className="text-lg font-semibold">
            Demander
          </h2>
          {(options.open_and_scan || pendingOpening?.status === 'requested') && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-white p-4">
              <p className="text-base font-semibold text-primary">Ouverture et numérisation</p>
              {options.open_and_scan && (
                <p className="text-sm text-muted-foreground">
                  {announce('open_and_scan')}
                  {pagesText && ` ${pagesText}`}
                </p>
              )}
              <MailboxRequest mailItemId={mail.id} mode={options.open_and_scan ? 'request' : 'cancel'} />
            </div>
          )}
          {options.scan && (
            <details className="rounded-lg border border-border bg-white px-3 py-2">
              <summary className={summaryClass}>Nouvelle numérisation</summary>
              <div className="pb-2 pt-3">
                <p className="mb-3 text-sm text-muted-foreground">
                  Pour des pages qui manquent, ou une numérisation effacée au terme de sa conservation.
                </p>
                <ScanRequestForm mailItemId={mail.id} announcement={announce('scan')} />
              </div>
            </details>
          )}
          {options.forward && (
            <details className="rounded-lg border border-border bg-white px-3 py-2">
              <summary className={summaryClass}>Réexpédition</summary>
              <div className="pb-2 pt-3">
                <p className="mb-3 text-sm text-muted-foreground">
                  Le pli vous est envoyé à l’adresse indiquée, qui est figée dans la demande. Une fois
                  réexpédié, il quitte le centre.
                </p>
                <ForwardRequestForm
                  mailItemId={mail.id}
                  clientId={mail.clientId}
                  previous={previous.map((option) => ({
                    requestId: option.requestId,
                    label: `Utilisée le ${formatDateTime(option.requestedAt, timeZone)}`,
                    lines: forwardAddressLines(option.address),
                  }))}
                  countries={forwardCountries.map((code) => ({ code, name: countryName(code) }))}
                  announcement={`${announce('forward')} Les frais d’affranchissement réels s’y ajoutent.`}
                />
              </div>
            </details>
          )}
        </section>
      )}

      <section aria-labelledby="suivi" className="flex flex-col gap-3">
        <h2 id="suivi" className="text-lg font-semibold">
          Suivi des demandes
        </h2>
        {mail.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune demande sur ce pli. Chaque demande, même annulée, restera visible ici.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {[...mail.requests].reverse().map((request) => (
              <li key={request.id}>
                <ClientRequestCard request={request} timeZone={timeZone} from="pli" showMail={false} showClient={false} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
