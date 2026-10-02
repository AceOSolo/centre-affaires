import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { rebuildAccountingExport } from '../../../../../modules/facturation/comptabilite.ts'
import { FecExportError } from '../../../../../modules/facturation/fec.ts'
import { formatIsoDateFr } from '../../../../../modules/facturation/paiements-regles.ts'

/**
 * Fichier d'un export du journal (R16, ADR 030), reconstruit et comparé à
 * l'empreinte inscrite à sa génération : seul le fichier identique se
 * télécharge sous ce nom.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requirePermission('comptabilite.exporter')
  const { id } = await params
  const text = (body: string, status: number) =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

  let rebuilt
  try {
    rebuilt = await rebuildAccountingExport(id)
  } catch (error) {
    if (error instanceof FecExportError) return text(`${error.message}.`, 409)
    throw error
  }
  if (!rebuilt) return text('Export introuvable.', 404)
  if (rebuilt.status === 'changed') {
    const { recorded } = rebuilt
    return text(
      `Les données du ${formatIsoDateFr(recorded.periodStart)} au ${formatIsoDateFr(recorded.periodEnd)} ont changé ` +
        'depuis la génération de cet export (paiement annulé, compte corrigé…) : le fichier ne correspond plus à ' +
        'son empreinte. Générez un nouvel export de la période et signalez-le à l’expert-comptable.',
      409,
    )
  }
  return new Response(rebuilt.content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${rebuilt.fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
