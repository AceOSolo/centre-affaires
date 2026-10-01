import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import {
  ContractDocumentView,
  type DocumentProvenance,
} from '../../../../../modules/contrats/document-view.tsx'
import {
  findContractDocument,
  previewContractSnapshot,
} from '../../../../../modules/contrats/documents.ts'
import type { ContractSnapshot } from '../../../../../modules/contrats/instantane.ts'
import { PrintButton } from '../../../../../modules/contrats/print-button.tsx'

export const metadata = { title: 'Document de contrat' }

/**
 * Rien n'est prérendu : le document dépend du contrat et de la session,
 * comme tout le back-office (voir la coque `(admin)/layout.tsx`).
 */
export const dynamic = 'force-dynamic'

/**
 * Vue imprimable d'un document de contrat (R12, ADR 025), hors de la coque du
 * back-office : une page propre, avec sa feuille d'impression, que le
 * navigateur imprime ou enregistre en PDF.
 *
 * - `?version=N` : le document archivé N, rendu depuis son instantané, avec
 *   son empreinte vérifiée par la base ;
 * - `?avenant=<id>` : l'aperçu d'un avenant, tel qu'il serait archivé ;
 * - sans paramètre : l'aperçu du contrat initial.
 */
export default async function ContractDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ version?: string; avenant?: string }>
}) {
  await requirePermission('contrats.consulter')
  const { id } = await params
  const { version, avenant } = await searchParams
  if (!isUuid(id)) notFound()

  let snapshot: ContractSnapshot | undefined
  let provenance: DocumentProvenance = { kind: 'preview' }
  let unreadable = false

  if (version !== undefined) {
    const number = Number(version)
    if (!Number.isInteger(number) || number < 1) notFound()
    const [document, timeZone] = await Promise.all([
      findContractDocument(id, number),
      currentTimeZone(),
    ])
    if (!document) notFound()
    snapshot = document.snapshot ?? undefined
    unreadable = document.snapshot === null
    provenance = {
      kind: 'archived',
      version: document.version,
      sha256: document.sha256,
      intact: document.intact,
      archivedAt: formatDateTime(document.createdAt, timeZone),
      archivedBy: document.generatedBy,
    }
  } else {
    if (avenant !== undefined && !isUuid(avenant)) notFound()
    snapshot = await previewContractSnapshot(id, avenant ?? null)
    if (!snapshot) notFound()
  }

  return (
    <main className="min-h-screen bg-muted py-8 font-sans text-foreground print:bg-white print:py-0">
      {/* Feuille d'impression : A4, marges du document, rien que le document. */}
      <style>{'@page { size: A4; margin: 15mm; }'}</style>
      <div className="mx-auto mb-6 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 px-4 print:hidden">
        <Link href={`/contrats/${id}#documents`} className="text-sm text-muted-foreground hover:underline">
          ← Retour au contrat
        </Link>
        <PrintButton />
      </div>
      {snapshot ? (
        <ContractDocumentView snapshot={snapshot} provenance={provenance} />
      ) : (
        <p
          role="alert"
          className="mx-auto max-w-[210mm] rounded-lg border border-border bg-white px-6 py-12 text-center text-sm"
        >
          {unreadable
            ? 'Ce document a été archivé sous une forme que cette version de l’application ne sait pas afficher. Il reste intact en base, avec son empreinte.'
            : 'Document introuvable.'}
        </p>
      )}
    </main>
  )
}
