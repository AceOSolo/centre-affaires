import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { loadClientBellSettings } from '../../../../modules/notifications/cloche-client-queries.ts'
import { ClientBellSettingsForm } from '../../../../modules/notifications/cloche-client-reglages-form.tsx'

export const metadata = { title: 'Cloche de l’espace client' }

/**
 * Réglage de la cloche de l'espace client (ADR 077), par centre : ce qu'elle
 * annonce aux clients et combien de temps. Droit `notifications.gerer`, comme
 * les modèles des messages ; ouvert depuis Réglages.
 */
export default async function ClientBellSettingsPage() {
  await requirePermission('notifications.gerer')
  const settings = await loadClientBellSettings()

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <LienRetour href="/reglages" label="Réglages" className="inline-flex min-h-6 items-center text-sm text-muted-foreground underline-offset-2 hover:underline" />
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Cloche de l’espace client</h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          En haut de leur espace, vos clients voient une cloche : le nombre de nouveautés qu’ils n’ont pas encore
          ouvertes — courrier reçu, numérisation prête, réponse à une demande, message du centre — et le lien vers
          chacune. Une nouveauté ouverte depuis la cloche passe en « lue », pour la personne qui l’a ouverte.
        </p>
      </div>
      <section className="rounded-2xl border border-border bg-white p-4 sm:p-6">
        <ClientBellSettingsForm settings={settings} />
      </section>
    </div>
  )
}
