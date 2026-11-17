import { isIsoMonth, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { ClientExpenses } from '../../../../modules/crm/compte-depenses.tsx'
import { ClientReceivedInvoices } from '../../../../modules/crm/compte-factures.tsx'
import { expenseMonths } from '../../../../modules/crm/depenses.ts'
import { expenseSettings, loadClientExpenses } from '../../../../modules/crm/depenses-queries.ts'
import {
  CLIENT_RECEIVED_INVOICE_LIMIT,
  invoicesFlowEnabled,
  listReceivedInvoicesForAccounts,
} from '../../../../modules/crm/factures-queries.ts'

export const metadata = { title: 'Dépenses et factures' }

/**
 * « Factures » de l'espace client (R17, ADR 081), sur deux sources :
 *
 * - **Mes dépenses** : ce que l'entreprise a consommé, mois par mois — frais
 *   fixes de ses contrats et prestations, selon les règles du registre des
 *   consommations (ADR 066) —, avec un total **estimé** : le site ne facture
 *   rien, le centre facture par son CRM en fin de mois. Réglable par le
 *   centre (Réglages > « Dépenses dans l'espace client ») ;
 * - **Mes factures** : celles que le CRM a émises, reçues par le flux
 *   « Factures » (`/api/dolibarr/factures`), avec leur état et leur PDF.
 *
 * Remplace la liste des factures du site, en sommeil depuis l'ADR 046 : aucune
 * n'y a jamais été émise. Jamais les données d'une autre entreprise : chaque
 * requête filtre sur les entreprises du compte (portée client, ADR 019).
 */
export default async function MesFacturesPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const [tenant, settings, invoices, flowEnabled, params] = await Promise.all([
    currentTenant(),
    expenseSettings(),
    listReceivedInvoicesForAccounts(accounts),
    invoicesFlowEnabled(),
    searchParams,
  ])
  const now = new Date()
  const today = todayIsoDate(tenant.timezone, now)
  const months = expenseMonths(today.slice(0, 7), settings.historyMonths)
  const selected = isIsoMonth(params.mois) && months.includes(params.mois) ? params.mois : months[0]!
  const expenses = settings.showExpenses
    ? await loadClientExpenses(accounts, {
        months,
        timeZone: tenant.timezone,
        now,
        estimateMailActs: settings.estimateMailActs,
      })
    : []

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Dépenses et factures</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          {settings.showExpenses
            ? 'Ce que vous consommez au centre, mois par mois, et les factures qu’il vous a émises.'
            : 'Les factures que le centre vous a émises, leur état et leur document.'}
        </p>
      </div>

      {settings.showExpenses && (
        <ClientExpenses months={expenses} selected={selected} note={settings.note} accounts={accounts} />
      )}

      <ClientReceivedInvoices
        invoices={invoices}
        today={today}
        tenant={tenant}
        flowEnabled={flowEnabled}
        several={accounts.length > 1}
        limit={CLIENT_RECEIVED_INVOICE_LIMIT}
      />
    </div>
  )
}
