import Link from 'next/link'

import { CheckIcon } from '../../../components/ui/icons.tsx'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { centreSettingsValues, missingInvoiceRequirements } from '../../../modules/facturation/parametres.ts'
import { CentreSettingsForms } from '../../../modules/facturation/parametres-form.tsx'

export const metadata = { title: 'Configuration du centre' }

/**
 * Paramètres du centre (R10) : règles tarifaires, facturation, identité légale
 * et coordonnées bancaires du vendeur. Réservé à l'exploitant
 * (`centre.configurer`, ADR 019) : ces valeurs engagent chaque prix et chaque
 * facture.
 */
export default async function ConfigurationPage() {
  await requirePermission('centre.configurer')
  const tenant = await currentTenant()
  const missing = missingInvoiceRequirements(tenant)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configuration du centre</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Règles de calcul des prix, conditions de facturation et identité du vendeur. Les délais de
          réservation du site public se règlent dans{' '}
          <Link href="/disponibilites" className="underline underline-offset-2">
            Disponibilités
          </Link>
          , les prix dans les{' '}
          <Link href="/tarifs" className="underline underline-offset-2">
            grilles tarifaires
          </Link>
          .
        </p>
      </div>

      {/* Ce que l'émission d'une facture exigera : dit avant qu'elle échoue. */}
      {missing.length > 0 ? (
        <div className="rounded-lg border border-statut-conflit/40 bg-white px-5 py-4 text-sm">
          <p className="font-medium">Facturation pas encore possible</p>
          <p className="mt-1 text-muted-foreground">
            Il manque au centre, pour émettre une facture : {missing.join(', ')}.
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-5 py-3 text-sm">
          <CheckIcon size={20} className="shrink-0 text-primary" />
          Les mentions du vendeur exigées sur une facture sont renseignées.
        </p>
      )}

      <CentreSettingsForms values={centreSettingsValues(tenant)} />
    </div>
  )
}
