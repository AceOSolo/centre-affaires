import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatDateTime } from '../../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../../modules/clients/session.ts'
import { findContractDocumentForAccounts } from '../../../../../../modules/contrats/compte-queries.ts'
import { ContractDocumentView } from '../../../../../../modules/contrats/document-view.tsx'
import { PrintButton } from '../../../../../../modules/facturation/print-button.tsx'

export const metadata = { title: 'Document de contrat' }

/** Rien n'est prérendu : le document dépend de la session (ADR 015). */
export const dynamic = 'force-dynamic'

/**
 * Une version archivée d'un document de contrat, vue depuis l'espace client
 * (R17, ADR 025) : `?version=N`, rendue depuis son instantané avec la même vue
 * que le back-office, et son empreinte vérifiée par la base.
 *
 * Le client ne voit que des documents archivés — jamais un aperçu, qui
 * montrerait des données du jour sans valeur contractuelle. Même réponse pour
 * « n'existe pas » et « pas à vous ».
 */
export default async function ClientContractDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ version?: string }>
}) {
  // Revérifié ici : cette page n'est pas sous la coque de l'espace client.
  const { accounts } = await requireClientAccount()
  const { id } = await params
  const { version } = await searchParams
  const number = Number(version)
  if (version === undefined || !Number.isInteger(number) || number < 1) notFound()

  const [archived, timeZone] = await Promise.all([
    findContractDocumentForAccounts(id, number, accounts),
    currentTimeZone(),
  ])
  if (!archived) notFound()

  return (
    <main
      id="contenu"
      className="min-h-screen bg-muted px-4 py-6 font-sans text-foreground sm:py-8 print:bg-white print:p-0"
    >
      {/* Feuille d'impression : A4, marges du document, rien que le document. */}
      <style>{'@page { size: A4; margin: 15mm; }'}</style>
      <div className="mx-auto mb-6 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/compte/contrats"
          className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          ← Mes contrats
        </Link>
        <PrintButton
          label="Imprimer ou enregistrer en PDF"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium text-foreground transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden"
        />
      </div>
      {archived.snapshot ? (
        <ContractDocumentView
          snapshot={archived.snapshot}
          provenance={{
            kind: 'archived',
            version: archived.version,
            sha256: archived.sha256,
            intact: archived.intact,
            archivedAt: formatDateTime(archived.createdAt, timeZone),
            // L'auteur est un membre de l'équipe : son nom reste au back-office.
            archivedBy: null,
          }}
        />
      ) : (
        <p
          role="alert"
          className="mx-auto max-w-[210mm] rounded-lg border border-border bg-white px-6 py-12 text-center text-sm"
        >
          Ce document a été archivé sous une forme que cette version de l’application ne sait pas
          afficher. Il reste intact, avec son empreinte : demandez-en un exemplaire au centre.
        </p>
      )}
    </main>
  )
}
