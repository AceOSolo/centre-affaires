import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { AmendmentForm } from '../../../../../../modules/contrats/amendment-form.tsx'
import {
  segmentResourceLabel,
  versionAmountLabel,
  versionLinesForForm,
} from '../../../../../../modules/contrats/avenant-ecran.ts'
import { defaultEffectiveOn } from '../../../../../../modules/contrats/avenant-formulaire.ts'
import { listAmendments } from '../../../../../../modules/contrats/avenants.ts'
import { billingPeriodSuffixes, contractStatusLabels } from '../../../../../../modules/contrats/labels.ts'
import { loadLinesCatalog } from '../../../../../../modules/contrats/offres-queries.ts'
import { findContract } from '../../../../../../modules/contrats/queries.ts'
import { findContractTerms, segmentOn } from '../../../../../../modules/contrats/versions.ts'
import { listResources } from '../../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouvel avenant' }

/**
 * Nouvel avenant sur un contrat en cours (R12, ADR 025) : un prix ou une
 * ressource qui change à une date d'effet. `?ressource=1` ouvre directement
 * le changement de ressource, depuis la fiche du contrat.
 */
export default async function NewAmendmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ ressource?: string }>
}) {
  await requirePermission('contrats.avenants')
  const { id } = await params
  const { ressource } = await searchParams
  if (!isUuid(id)) notFound()
  const contract = await findContract(id)
  if (!contract) notFound()

  const back = (
    <Link href={`/contrats/${id}`} className="text-sm text-muted-foreground hover:underline">
      ← Contrat {contract.reference}
    </Link>
  )

  if (contract.status !== 'active' || contract.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Nouvel avenant</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          {contract.deletedAt
            ? 'Ce contrat est archivé : il ne reçoit plus d’avenant.'
            : contract.status === 'draft'
              ? 'Un brouillon se modifie directement, sans avenant : ses lignes, sa ressource et son prix restent libres jusqu’à l’activation.'
              : `Ce contrat est ${contractStatusLabels[contract.status].toLowerCase()} : il ne reçoit plus d’avenant.`}{' '}
          <Link href={`/contrats/${id}`} className="underline underline-offset-2">
            Revenir au contrat
          </Link>
        </p>
      </div>
    )
  }

  const [terms, amendments, timeZone, resources] = await Promise.all([
    findContractTerms(id),
    listAmendments(id),
    currentTimeZone(),
    listResources(),
  ])
  const lastSigned = amendments
    .filter((amendment) => amendment.status === 'signed')
    .reduce<string | null>(
      (latest, amendment) => (latest && latest > amendment.effectiveOn ? latest : amendment.effectiveOn),
      null,
    )
  const effectiveOn = defaultEffectiveOn(todayIsoDate(timeZone), contract.startsOn, lastSigned)
  const version = segmentOn(terms.versions, effectiveOn)
  const initialLines = versionLinesForForm(version, contract)
  const catalog = await loadLinesCatalog(version?.lines ?? [])
  const changesResource = ressource === '1'

  return (
    <div className="flex flex-col gap-6">
      <div>
        {back}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvel avenant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {contract.reference} — {contract.client.name}. L’avenant est établi en brouillon : il se
          relit, puis se signe.
        </p>
      </div>
      <AmendmentForm
        contractId={id}
        defaults={{
          effectiveOn,
          reason: '',
          priceMode: changesResource ? 'unchanged' : 'lines',
          amount: '',
          changesResource,
          resourceId: '',
        }}
        initialLines={initialLines}
        catalog={catalog}
        resources={resources}
        currentResourceLabel={segmentResourceLabel(terms.segments, effectiveOn)}
        currentAmountLabel={versionAmountLabel(terms.versions, effectiveOn, contract)}
        periodSuffix={billingPeriodSuffixes[contract.billingPeriod]}
        currency={contract.currency}
      />
    </div>
  )
}
