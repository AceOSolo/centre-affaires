import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { OfferForm } from '../../../../modules/facturation/offer-form.tsx'

export const metadata = { title: 'Nouvelle offre' }

export default async function NewOfferPage() {
  await requirePermission('services.gerer')
  return (
    <div className="flex flex-col gap-6">
      <div>
        <LienRetour href="/offres" label="Offres groupées" />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle offre</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ses ressources et ses services s’ajoutent ensuite, avec l’aperçu du prix.
        </p>
      </div>
      <OfferForm
        defaults={{ name: '', description: '', billingPeriod: 'monthly', commitmentMonths: '', clientVisible: '' }}
      />
    </div>
  )
}
