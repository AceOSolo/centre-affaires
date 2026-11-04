import Link from 'next/link'

import { CheckIcon, XIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { smtpStatus, SMTP_VARIABLES } from '../../lib/courriel.ts'
import { notificationEventLabels } from './catalogue.ts'
import { listRecentFailures } from './courriels-queries.ts'
import { TestEmailForm } from './essai-courriel-form.tsx'

/**
 * Encart « Courriels » de Réglages (ADR 059) : l'envoi est-il configuré, un
 * essai à sa propre adresse, et les derniers échecs du journal des messages.
 *
 * La configuration vit dans le `.env` du serveur (`SMTP_*`, `MAIL_FROM`,
 * `infra/serveur/README.md` § 8), jamais en base : l'encart la constate, il
 * ne la modifie pas, et ne montre ni l'identifiant ni la clé.
 */
export async function EmailSettingsPanel({ address, timeZone }: { address: string; timeZone: string }) {
  const status = smtpStatus()
  const failures = await listRecentFailures()

  return (
    <section aria-labelledby="reglages-courriels" className="flex flex-col gap-3">
      <h2 id="reglages-courriels" className="text-lg font-semibold tracking-tight">
        Courriels
      </h2>
      <div className="flex flex-col gap-5 rounded-lg border border-border bg-white p-5">
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            {status.configured ? (
              <CheckIcon size={20} className="shrink-0 text-primary" />
            ) : (
              <XIcon size={20} className="shrink-0 text-primary" />
            )}
            {status.configured ? 'Envoi configuré' : 'Envoi non configuré : aucun courriel ne part'}
          </p>
          {status.configured ? (
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Serveur</dt>
              <dd className="tabular">
                {status.host}, port {status.port}
              </dd>
              <dt className="text-muted-foreground">Chiffrement</dt>
              <dd>{status.security}</dd>
              <dt className="text-muted-foreground">Expéditeur</dt>
              <dd>{status.from}</dd>
            </dl>
          ) : (
            <p className="max-w-prose text-sm text-muted-foreground">
              {/* Pas de `<code>` : il passerait en police monospace, que la charte exclut. */}
              Les messages sont inscrits au journal comme « SMTP non configuré ». À poser dans le
              fichier <span className="font-medium text-foreground">.env</span> du serveur, puis relancer
              l’application :{' '}
              {SMTP_VARIABLES.map((name, index) => (
                <span key={name}>
                  {index > 0 && ', '}
                  <span className="font-medium text-foreground">{name}</span>
                </span>
              ))}
              {status.missing.length > 0 && ` (manquant : ${status.missing.join(', ')})`}. La marche à
              suivre avec Brevo est dans la notice du serveur, section 8.
            </p>
          )}
        </div>

        <TestEmailForm address={address} />

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Derniers échecs d’envoi</h3>
          {failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun échec au journal des messages. Un envoi refusé par le serveur SMTP s’y inscrirait
              avec sa cause.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2">Le</th>
                    <th scope="col" className="px-3 py-2">Message</th>
                    <th scope="col" className="px-3 py-2">Cause</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {failures.map((failure) => (
                    <tr key={failure.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 tabular">{formatDateTime(failure.sentAt, timeZone)}</td>
                      <td className="px-3 py-2">
                        {notificationEventLabels[failure.event]}
                        <span className="block text-xs text-muted-foreground">
                          {failure.subject} · {failure.failedCount} destinataire{failure.failedCount > 1 ? 's' : ''} non
                          servi{failure.failedCount > 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{failure.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Link
            href="/notifications?statut=failed"
            className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Voir tous les échecs dans le journal des messages
          </Link>
        </div>
      </div>
    </section>
  )
}
