import Link from 'next/link'

import { ArrowLeftIcon } from '../../../../components/ui/icons.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { expenseSettings } from '../../../../modules/crm/depenses-queries.ts'
import { ExpenseSettingsForm } from '../../../../modules/crm/depenses-reglages-form.tsx'

export const metadata = { title: 'Dépenses dans l’espace client' }

/**
 * « Dépenses dans l'espace client » (ADR 081) : ce que la page « Factures »
 * de l'espace client montre des dépenses de chaque entreprise. Le site ne
 * facture rien : il estime, Dolibarr facture. Réglé par centre, par qui
 * configure le centre (`centre.configurer`).
 */
export default async function DepensesClientsPage() {
  await requirePermission('centre.configurer')
  const settings = await expenseSettings()

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/reglages"
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon size={20} />
          Réglages
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Dépenses dans l’espace client</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Chaque entreprise retrouve dans son espace, rubrique « Factures », ses dépenses du mois — frais
          fixes de ses contrats et prestations : réservations, actes du courrier, affranchissement — et
          les factures que le CRM lui a émises. Les dépenses sont une <strong>estimation</strong> : le site
          ne facture rien, le CRM facture.
        </p>
      </div>

      <section
        aria-labelledby="depenses-reglages"
        className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
      >
        <h2 id="depenses-reglages" className="text-lg font-semibold tracking-tight">
          Ce que l’espace client montre
        </h2>
        <ExpenseSettingsForm settings={settings} />
      </section>

      <p className="max-w-[70ch] text-sm text-muted-foreground">
        Les factures arrivent du CRM par le flux « Factures », à ouvrir dans{' '}
        <Link href="/reglages/crm" className="font-medium text-primary underline-offset-2 hover:underline">
          Connexion au CRM
        </Link>{' '}
        (direction) une fois le connecteur prêt.
      </p>
    </div>
  )
}
