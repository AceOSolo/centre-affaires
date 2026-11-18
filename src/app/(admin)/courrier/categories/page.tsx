import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { saveCentreCategoriesAction } from '../../../../modules/courrier/categories-centre-actions.ts'
import { listCentreCategories } from '../../../../modules/courrier/categories-reglages.ts'
import { CategoryListForm } from '../../../../modules/courrier/categories-reglages-forms.tsx'

export const metadata = { title: 'Catégories du courrier' }

/**
 * Catégories du courrier proposées aux clients (ADR 078), rangées dans
 * Réglages, service Domiciliation : leur nom, leur ordre, et celles qu'on ne
 * propose plus. La liste reste celle de l'ADR 044 — dix catégories, sans
 * ajout : chaque client crée les siennes (ADR 060) et peut, pour lui seul,
 * renommer, masquer et ordonner celles-ci.
 *
 * Réglage du centre (`centre.configurer`, exploitant et direction).
 */
export default async function CategoriesCourrierPage() {
  await requirePermission('centre.configurer')
  const categories = await listCentreCategories()

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <LienRetour href="/reglages" label="Réglages" icone className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Catégories du courrier</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Les catégories que l’espace client propose aux domiciliés pour ranger leur courrier, comme
          dans un espace bancaire. Le centre ne voit jamais comment ses clients rangent leurs plis :
          ce réglage ne change que les noms et l’ordre proposés. On ne peut pas en ajouter ; chaque
          client crée les siennes.
        </p>
      </div>
      <CategoryListForm
        action={saveCentreCategoriesAction}
        rows={categories.map((category) => ({
          key: category.category,
          kind: 'proposee',
          name: category.name,
          originName: category.codeName,
          hidden: category.hidden,
        }))}
        submitLabel="Enregistrer les catégories"
        audience="centre"
      />
    </div>
  )
}
