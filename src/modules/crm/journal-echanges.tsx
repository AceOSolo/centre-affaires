import { ArrowLeftIcon, ArrowRightIcon, BanIcon, CheckIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { crmFlowDefinitions } from './flux.ts'
import { CRM_EXCHANGE_RETENTION_DAYS, type CrmExchangeRow } from './queries.ts'

/**
 * Journal des derniers échanges du centre avec son CRM (ADR 065). Le résultat
 * se lit par une icône et par le texte, jamais par la couleur seule.
 */
export function CrmExchangesTable({
  exchanges,
  timeZone,
  crmLabel,
}: {
  exchanges: CrmExchangeRow[]
  timeZone: string
  crmLabel: string
}) {
  if (exchanges.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-white px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Aucun échange pour l’instant. Le journal se remplit au premier appel de {crmLabel} : remettez-lui
          son jeton, puis revenez ici. « Tester la connexion » y inscrit aussi son essai.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            Derniers échanges avec {crmLabel}, les plus récents d’abord
          </caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Quand</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Sens</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Flux</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Opération</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Résultat</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Détail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {exchanges.map((exchange) => (
              <tr key={exchange.id} className="align-top">
                <td className="tabular whitespace-nowrap px-4 py-2">{formatDateTime(exchange.createdAt, timeZone)}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  {exchange.direction === 'inbound' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ArrowLeftIcon size={20} className="shrink-0 text-primary" />
                      Appel reçu
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <ArrowRightIcon size={20} className="shrink-0 text-primary" />
                      Appel du site
                    </span>
                  )}
                  {exchange.credential && (
                    <span className="block text-xs text-muted-foreground">
                      {exchange.credential === 'screen' ? 'jeton de l’écran' : 'jeton du serveur'}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  {exchange.flow ? crmFlowDefinitions[exchange.flow].label : 'Connexion'}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{exchange.operation}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  {exchange.ok ? (
                    <span className="inline-flex items-center gap-1.5">
                      <CheckIcon size={20} className="shrink-0 text-primary" />
                      Réussi
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <BanIcon size={20} className="shrink-0" />
                      Échec
                    </span>
                  )}
                  <span className="tabular ml-1.5 text-xs text-muted-foreground">
                    {exchange.statusCode ?? 'sans réponse'}
                  </span>
                </td>
                <td className="min-w-64 px-4 py-2 text-muted-foreground">{exchange.message ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Les {exchanges.length} derniers échanges. Le journal garde {CRM_EXCHANGE_RETENTION_DAYS} jours, sans
        jeton ni contenu échangé.
      </p>
    </div>
  )
}
