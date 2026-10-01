import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { can } from '../../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { EInvoicingSection } from '../../../../../modules/facturation/en16931-section.tsx'
import { amountDueCents } from '../../../../../modules/facturation/montants.ts'
import { formatIsoDateFr } from '../../../../../modules/facturation/paiements-regles.ts'
import { SettlementSection } from '../../../../../modules/facturation/reglement-section.tsx'
import { findInvoiceSettlement } from '../../../../../modules/facturation/reglements.ts'

export const metadata = { title: 'Règlement d’une facture' }

/** Une `Map` et non un objet : `?paiement=constructor` ne doit rien trouver. */
const notices = new Map([
  ['enregistre', 'Paiement pointé. L’état de la facture est à jour.'],
  ['annule', 'Pointage annulé. Il reste dans l’historique, avec son motif.'],
  ['deja-annule', 'Ce pointage était déjà annulé : rien n’a changé.'],
])

/**
 * Fiche de règlement d'une facture (R16) : paiements pointés, pointage d'un
 * nouveau paiement, et préparation de la facturation électronique (EN 16931).
 */
export default async function InvoiceSettlementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ paiement?: string }>
}) {
  const { member } = await requirePermission('facturation.consulter')
  const [{ id }, { paiement }] = await Promise.all([params, searchParams])
  if (!isUuid(id)) notFound()
  const settlement = await findInvoiceSettlement(id)
  if (!settlement) notFound()

  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const { invoice, client } = settlement
  const notice = typeof paiement === 'string' ? notices.get(paiement) : undefined
  const title =
    invoice.status === 'draft'
      ? invoice.kind === 'credit_note'
        ? 'Brouillon d’avoir'
        : 'Brouillon de facture'
      : `${invoice.kind === 'credit_note' ? 'Avoir' : 'Facture'} ${invoice.number}`
  const overdue =
    invoice.kind === 'invoice' &&
    invoice.status !== 'draft' &&
    invoice.dueDate !== null &&
    invoice.dueDate < today &&
    amountDueCents(invoice) > 0

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/paiements" className="text-sm text-muted-foreground hover:underline">
          ← Règlements
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight tabular">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {can(member.role, 'clients.gerer') ? (
            <Link href={`/clients/${client.id}`} className="underline-offset-2 hover:underline">
              {client.name}
            </Link>
          ) : (
            client.name
          )}
          {' · '}période du {formatIsoDateFr(invoice.periodStart)} au {formatIsoDateFr(invoice.periodEnd)}
          {invoice.issueDate && <> · émise le {formatIsoDateFr(invoice.issueDate)}</>}
        </p>
        {overdue && (
          <div className="mt-3">
            <Link
              href={`/paiements/factures/${invoice.id}/relance`}
              className="inline-block rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Lettre de relance
            </Link>
          </div>
        )}
      </div>

      {notice && <FlashNotice key={paiement}>{notice}</FlashNotice>}

      <SettlementSection
        settlement={settlement}
        canManage={can(member.role, 'paiements.gerer')}
        today={today}
        timeZone={timeZone}
      />
      <EInvoicingSection settlement={settlement} />
    </div>
  )
}
