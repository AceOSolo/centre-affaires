import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { RatePlanForm } from '../../../../modules/facturation/rate-plan-form.tsx'

export const metadata = { title: 'Nouvelle grille tarifaire' }

export default async function NewRatePlanPage() {
  await requirePermission('tarifs.gerer')
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/tarifs" className="text-sm text-muted-foreground hover:underline">
          ← Grilles tarifaires
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle grille</h1>
      </div>
      <RatePlanForm />
    </div>
  )
}
