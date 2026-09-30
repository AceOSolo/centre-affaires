import { ClockIcon, MailIcon, MailOpenIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import {
  mailKindLabels,
  mailStatusClientLabels,
  mailStatusStyles,
} from '../../../../modules/courrier/labels.ts'
import { MailboxRequest } from '../../../../modules/courrier/mailbox-request.tsx'
import { listMailForAccounts } from '../../../../modules/courrier/queries.ts'
import type { MailStatus } from '../../../../modules/courrier/schema.ts'

export const metadata = { title: 'Ma boîte aux lettres' }

const statusIcons: Record<MailStatus, typeof MailIcon> = {
  received: MailIcon,
  opening_requested: ClockIcon,
  opened: MailOpenIcon,
}

/**
 * Boîte aux lettres de l'entreprise domiciliée.
 *
 * Mobile d'abord : on la consulte au téléphone, entre deux rendez-vous. Une
 * carte par pli, les actions en pleine largeur et à 44 px de haut.
 */
export default async function BoiteAuxLettresPage() {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const [tenant, mail] = await Promise.all([currentTenant(), listMailForAccounts(accounts)])
  const timeZone = tenant.timezone
  const retention = tenant.mailScanRetentionMonths
  const several = accounts.length > 1
  const waiting = mail.filter((item) => item.status === 'opening_requested').length

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Ma boîte aux lettres
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Le courrier reçu au centre à votre nom. Demandez l’ouverture d’un pli pour en recevoir
          ici la numérisation.
        </p>
        {/* Transparence RGPD : la personne sait combien de temps ses documents restent. */}
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les numérisations sont conservées {retention} mois, puis effacées. Téléchargez celles
          que vous souhaitez garder.
        </p>
        {waiting > 0 && (
          <p className="mt-2 text-sm text-primary">
            {waiting} demande{waiting > 1 ? 's' : ''} d’ouverture en cours.
          </p>
        )}
      </div>

      {mail.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <MailIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Aucun courrier pour l’instant. Chaque pli reçu au centre à votre nom apparaîtra ici.
          </p>
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-4">
          {mail.map((item) => {
            const StatusIcon = statusIcons[item.status]
            return (
              <li key={item.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                <article aria-labelledby={`pli-${item.id}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${mailStatusStyles[item.status]}`}
                    >
                      <StatusIcon size={16} />
                      {mailStatusClientLabels[item.status]}
                    </span>
                    <span className="text-muted-foreground">{mailKindLabels[item.kind]}</span>
                    {several && (
                      <span className="text-muted-foreground">· {item.clientName}</span>
                    )}
                  </div>

                  <div>
                    <h2 id={`pli-${item.id}`} className="text-base font-semibold">
                      {item.sender ?? 'Expéditeur non précisé'}
                    </h2>
                    <p className="text-sm text-muted-foreground tabular">
                      Reçu le {formatDateTime(item.receivedAt, timeZone)}
                    </p>
                    {item.status === 'opening_requested' && item.openingRequestedAt && (
                      <p className="text-sm text-muted-foreground tabular">
                        Ouverture demandée le {formatDateTime(item.openingRequestedAt, timeZone)}.
                        La numérisation apparaîtra ici.
                      </p>
                    )}
                    {item.openedAt && (
                      <p className="text-sm text-muted-foreground tabular">
                        Numérisé le {formatDateTime(item.openedAt, timeZone)}
                        {!item.contentScanId &&
                          ' — numérisation effacée au terme de sa durée de conservation'}
                      </p>
                    )}
                  </div>

                  {item.note && (
                    <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">
                      {item.note}
                    </p>
                  )}

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
                    {item.envelopeScanId && (
                      <a
                        href={`/compte/scans/${item.envelopeScanId}`}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted"
                      >
                        <MailIcon size={20} />
                        Voir l’enveloppe
                      </a>
                    )}
                    {/* Une seule position pour les deux modes : le composant
                        survit au passage de l'un à l'autre, et son message de
                        confirmation reste annoncé. */}
                    {item.status !== 'opened' && (
                      <MailboxRequest
                        mailItemId={item.id}
                        mode={item.status === 'received' ? 'request' : 'cancel'}
                      />
                    )}
                  </div>
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
