import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { ContractLinesForm } from '../../../../../modules/contrats/contract-lines-form.tsx'
import { billingPeriodSuffixes, contractStatusLabels } from '../../../../../modules/contrats/labels.ts'
import { lineToFormValues, targetOf } from '../../../../../modules/contrats/lignes.ts'
import { loadLinesCatalog } from '../../../../../modules/contrats/offres-queries.ts'
import { findContract } from '../../../../../modules/contrats/queries.ts'
import { findContractTerms } from '../../../../../modules/contrats/versions.ts'

export const metadata = { title: 'Lignes du contrat' }

/**
 * Lignes d'un contrat brouillon (R12, ADR 025) : ce que le contrat facture à
 * chaque période, ligne à ligne. Le montant du contrat en découle. Un contrat
 * engagé ne change plus ici : ses lignes changent par avenant.
 */
export default async function ContractLinesPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('contrats.creer')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const contract = await findContract(id)
  if (!contract) notFound()

  const back = (
    <Link href={`/contrats/${id}`} className="text-sm text-muted-foreground hover:underline">
      ← Contrat {contract.reference}
    </Link>
  )

  if (contract.status !== 'draft' || contract.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Lignes du contrat</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          {contract.deletedAt
            ? 'Ce contrat est archivé : ses lignes ne se modifient plus.'
            : `Ce contrat n’est plus un brouillon (${contractStatusLabels[contract.status].toLowerCase()}) : ses lignes changent par avenant, à une date d’effet.`}{' '}
          <Link href={`/contrats/${id}`} className="underline underline-offset-2">
            Revenir au contrat
          </Link>
        </p>
      </div>
    )
  }

  const { versions } = await findContractTerms(id)
  const lines = versions.find((version) => version.amendmentId === null)?.lines ?? []
  const catalog = await loadLinesCatalog(lines)

  return (
    <div className="flex flex-col gap-6">
      <div>
        {back}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Lignes du contrat</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {contract.reference} — {contract.client.name}. Montants HT{' '}
          {billingPeriodSuffixes[contract.billingPeriod]}, période entière ; une période partielle
          est proratisée selon la règle du centre.
        </p>
      </div>
      <ContractLinesForm
        contractId={id}
        initial={lines.map((line, index) =>
          lineToFormValues(String(index), {
            ...line,
            target: targetOf(line),
          }),
        )}
        catalog={catalog}
        periodSuffix={billingPeriodSuffixes[contract.billingPeriod]}
        currency={contract.currency}
      />
    </div>
  )
}
