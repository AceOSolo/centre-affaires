import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { checkEn16931, en16931Summary, toEn16931 } from '../../../../../../modules/facturation/en16931.ts'
import { findInvoiceSettlement } from '../../../../../../modules/facturation/reglements.ts'

/**
 * Représentation EN 16931 d'une facture émise, en JSON (R16, ADR 028) : ce que
 * le raccordement à la plateforme agréée convertira. Aucun envoi.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requirePermission('facturation.consulter')
  const { id } = await params
  const settlement = await findInvoiceSettlement(id)
  if (!settlement) return new Response('Facture introuvable.', { status: 404 })
  if (settlement.invoice.status === 'draft' || !settlement.invoice.number) {
    return new Response('Un brouillon n’a pas encore de représentation EN 16931 : émettez la facture.', {
      status: 409,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const invoice = toEn16931({
    invoice: settlement.invoice,
    lines: settlement.lines,
    precedingInvoice: settlement.precedingInvoice,
  })
  const checks = checkEn16931(invoice)
  const body = JSON.stringify({ invoice, checks, summary: en16931Summary(checks) }, null, 2)
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${settlement.invoice.number}-en16931.json"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
