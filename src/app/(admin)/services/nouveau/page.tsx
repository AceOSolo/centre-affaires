import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { bpToPercentInput } from '../../../../modules/facturation/saisie.ts'
import { ServiceForm } from '../../../../modules/facturation/service-form.tsx'
import { expectedServices } from '../../../../modules/facturation/services-attendus.ts'

export const metadata = { title: 'Nouveau service' }

/**
 * Création d'un service. `?code=courrier.ouverture` préremplit un service
 * attendu par l'application (`services-attendus.ts`) : désignation, nature,
 * unité et TVA sont proposées, le code est figé, le prix reste à saisir.
 */
export default async function NewServicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  await requirePermission('services.gerer')
  const [{ code }, tenant] = await Promise.all([searchParams, currentTenant()])
  const expected = expectedServices.find((service) => service.code === code)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/services" className="text-sm text-muted-foreground hover:underline">
          ← Services
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {expected ? expected.name : 'Nouveau service'}
        </h1>
        {expected && (
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {expected.purpose} La désignation, la nature et la TVA sont proposées ; fixez le prix
            du centre.
          </p>
        )}
      </div>
      <ServiceForm
        lockedCode={Boolean(expected)}
        defaults={{
          code: expected?.code ?? '',
          name: expected?.name ?? '',
          description: expected?.description ?? '',
          nature: expected?.nature ?? 'package',
          unit: expected?.unit ?? 'month',
          unitPrice: '',
          vatRate: bpToPercentInput(expected?.vatRateBp ?? tenant.defaultVatRateBp),
          isActive: true,
        }}
      />
    </div>
  )
}
