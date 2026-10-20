import Link from 'next/link'

import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CreditCardIcon,
  FileTextIcon,
  MailIcon,
} from '../../../components/ui/icons.tsx'
import { formatCalendarDate, formatDateTime, formatLongDate, formatTime, toIsoDate } from '../../../lib/dates.ts'
import { contractTypeLabels } from '../../../modules/contrats/labels.ts'
import { mailKindLabels } from '../../../modules/courrier/labels.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'
import { requireClientAccount } from '../../../modules/clients/session.ts'
import { loadClientSpace } from './espace.ts'

export const metadata = { title: 'Mon espace' }

const primaire = 'press inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover'
const lien = 'inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline'

/**
 * Accueil de l'espace client : ce qui demande une action d'abord, puis une
 * carte par sujet que l'entreprise utilise. Chaque carte mène à sa rubrique ;
 * aucune n'apparaît vide — un nouveau client voit seulement de quoi réserver.
 */
export default async function CompteAccueilPage() {
  const space = await loadClientSpace(await requireClientAccount())
  const { user, tenant, upcoming, outstanding, overdueInvoices, mail, latestMail, activeContracts, toSign, domiciliated } = space
  const timeZone = tenant.timezone
  const prenom = user.name?.trim().split(/\s+/)[0]
  const prochaine = upcoming[0]
  const aRegler = outstanding.reduce((count, total) => count + total.count, 0)

  const aFaire = [
    aRegler > 0 && {
      href: '/compte/factures',
      Icon: CreditCardIcon,
      texte: `${aRegler} facture${aRegler > 1 ? 's' : ''} à régler`,
      detail: [
        outstanding.map((total) => formatCents(total.dueCents, total.currency)).join(' + '),
        overdueInvoices > 0 ? `dont ${overdueInvoices} en retard` : '',
      ].filter(Boolean).join(', '),
    },
    toSign > 0 && {
      href: '/compte/etats-des-lieux',
      Icon: FileTextIcon,
      texte: `${toSign} état${toSign > 1 ? 's' : ''} des lieux à signer`,
      detail: 'Relisez-le et signez en ligne.',
    },
    domiciliated && mail.unread > 0 && {
      href: '/compte/courrier',
      Icon: MailIcon,
      texte: `${mail.unread} pli${mail.unread > 1 ? 's' : ''} non lu${mail.unread > 1 ? 's' : ''}`,
      detail: 'Dans votre boîte aux lettres.',
    },
  ].filter((item): item is Exclude<typeof item, false> => item !== false)

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl">
          Bonjour{prenom ? ` ${prenom}` : ''}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {aFaire.length > 0
            ? `${aFaire.length} chose${aFaire.length > 1 ? 's' : ''} à voir aujourd’hui.`
            : 'Rien ne vous attend pour le moment.'}
        </p>
      </div>

      {aFaire.length > 0 && (
        <section aria-labelledby="a-faire">
          <h2 id="a-faire" className="sr-only">À faire</h2>
          <ul className="grid gap-3 lg:grid-cols-3">
            {aFaire.map(({ href, Icon, texte, detail }) => (
              <li key={href}>
                <Link href={href} className="group flex min-h-11 items-center gap-4 rounded-lg border-2 border-primary/20 bg-accent/5 p-4 transition-colors hover:border-primary">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Icon size={22} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-primary">{texte}</span>
                    {detail && <span className="mt-0.5 block text-sm text-muted-foreground">{detail}</span>}
                  </span>
                  <ArrowRightIcon size={20} className="shrink-0 text-primary transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Carte titre="Réservations" Icon={CalendarIcon}>
          {prochaine ? (
            <>
              <p className="text-sm text-muted-foreground">Prochaine réservation</p>
              <p className="mt-1 text-lg font-semibold text-foreground first-letter:uppercase">{formatLongDate(toIsoDate(prochaine.startsAt, timeZone), timeZone)}</p>
              <p className="mt-0.5 tabular">{formatTime(prochaine.startsAt, timeZone)} – {formatTime(prochaine.endsAt, timeZone)} · {prochaine.resourceName}</p>
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm font-medium text-primary">
                {prochaine.status === 'confirmed' ? <CheckIcon size={16} /> : <ClockIcon size={16} />}
                {prochaine.status === 'confirmed' ? 'Confirmée' : 'En attente de validation par le centre'}
              </p>
              {upcoming.length > 1 && <p className="mt-3 text-sm text-muted-foreground">Et {upcoming.length - 1} autre{upcoming.length > 2 ? 's' : ''} à venir.</p>}
            </>
          ) : (
            <p className="text-muted-foreground">Aucune réservation à venir. Salles et bureaux se réservent ici, à l’heure ou à la journée.</p>
          )}
          <Actions>
            <Link href="/compte/reservations/nouvelle" className={primaire}>Réserver un créneau</Link>
            <Link href="/compte/reservations" className={lien}>Toutes mes réservations <ArrowRightIcon size={16} /></Link>
          </Actions>
        </Carte>

        {domiciliated && (
          <Carte titre="Courrier" Icon={MailIcon}>
            {latestMail.length === 0 ? (
              <p className="text-muted-foreground">Aucun pli reçu pour le moment. Nous vous prévenons à chaque arrivée.</p>
            ) : (
              <ul className="divide-y divide-border">
                {latestMail.map((pli) => (
                  <li key={pli.id} className="flex items-baseline justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className={`block truncate ${pli.classification.readAt ? 'text-foreground' : 'font-semibold text-primary'}`}>
                        {pli.sender ?? 'Expéditeur non indiqué'}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {mailKindLabels[pli.kind]}{pli.classification.readAt ? '' : ' · non lu'}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm text-muted-foreground tabular">{formatDateTime(pli.receivedAt, timeZone)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Actions>
              <Link href="/compte/courrier" className={primaire}>Ouvrir ma boîte aux lettres</Link>
            </Actions>
          </Carte>
        )}

        {space.invoiceCount > 0 && (
          <Carte titre="Factures" Icon={CreditCardIcon}>
            {aRegler > 0 ? (
              <>
                <p className="text-sm text-muted-foreground">Reste à régler</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight text-primary tabular">
                  {outstanding.map((total) => formatCents(total.dueCents, total.currency)).join(' + ')}
                </p>
                {overdueInvoices > 0 && <p className="mt-1 text-sm text-muted-foreground">Dont {overdueInvoices} facture{overdueInvoices > 1 ? 's' : ''} échue{overdueInvoices > 1 ? 's' : ''}.</p>}
              </>
            ) : (
              <p className="flex items-center gap-2 text-foreground"><CheckIcon size={20} className="text-primary" />Tout est réglé.</p>
            )}
            <Actions>
              <Link href="/compte/factures" className={lien}>Voir mes factures <ArrowRightIcon size={16} /></Link>
            </Actions>
          </Carte>
        )}

        {activeContracts.length > 0 && (
          <Carte titre={activeContracts.length > 1 ? 'Contrats en cours' : 'Contrat en cours'} Icon={FileTextIcon}>
            <ul className="divide-y divide-border">
              {activeContracts.map((contrat) => (
                <li key={contrat.id} className="py-2.5 first:pt-0">
                  <p className="font-medium text-foreground">{contractTypeLabels[contrat.contractType]}</p>
                  <p className="text-sm text-muted-foreground">
                    Depuis le {formatCalendarDate(contrat.startsOn)}{contrat.endsOn ? `, jusqu’au ${formatCalendarDate(contrat.endsOn)}` : ''} · réf. {contrat.reference}
                  </p>
                </li>
              ))}
            </ul>
            <Actions>
              <Link href="/compte/contrats" className={lien}>Voir mes contrats <ArrowRightIcon size={16} /></Link>
            </Actions>
          </Carte>
        )}

        {space.offerCount > 0 && (
          <Carte titre="Besoin d’une formule au mois ?" Icon={CheckIcon}>
            <p className="text-muted-foreground">Bureau, domiciliation, services : nos formules à prix fixe, sans engagement avant la signature du contrat.</p>
            <Actions>
              <Link href="/compte/offres" className={lien}>Voir les formules <ArrowRightIcon size={16} /></Link>
            </Actions>
          </Carte>
        )}
      </div>
    </div>
  )
}

function Carte({ titre, Icon, children }: { titre: string; Icon: typeof MailIcon; children: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-xl border border-border bg-background p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold text-primary">
        <Icon size={20} />
        {titre}
      </h2>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </section>
  )
}

/** Les actions d'une carte, toujours au même endroit : en bas. */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-5">{children}</div>
}
