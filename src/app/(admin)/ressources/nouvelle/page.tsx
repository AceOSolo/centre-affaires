import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { ResourceForm } from '../../../../modules/ressources/resource-form.tsx'

export const metadata = { title: 'Nouvelle ressource' }

export default async function NewResourcePage() {
  await requirePermission('ressources.gerer')
  return (
    <div className="flex flex-col gap-6">
      <div>
        <LienRetour href="/ressources" label="Ressources" />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle ressource</h1>
      </div>
      <ResourceForm />
    </div>
  )
}
