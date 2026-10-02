import { amountDueCents } from './montants.ts'
import type { Invoice } from './schema-factures.ts'

/**
 * Une facture vue depuis l'espace client (R17) : ce qu'elle demande au client,
 * dit en toutes lettres. Le statut de la base (`invoice_payment_status()`)
 * parle au comptable ; le client, lui, veut savoir s'il doit payer, combien,
 * et si l'échéance est passée.
 *
 * Fonctions pures : la page et l'historique les partagent, et elles se
 * testent sans base.
 */

/**
 * - `due` : à régler, échéance pas encore passée ;
 * - `overdue` : à régler, échéance passée ;
 * - `partial` : payée en partie, échéance pas encore passée ;
 * - `settled` : rien à régler ;
 * - `cancelled` : annulée par un avoir ;
 * - `credit` : un avoir, qui vient en déduction.
 */
export type ClientInvoiceTone = 'due' | 'overdue' | 'partial' | 'settled' | 'cancelled' | 'credit'

export type ClientInvoiceState = {
  tone: ClientInvoiceTone
  label: string
  /** Reste à régler, en centimes ; 0 quand rien n'est dû (avoir, payée, annulée). */
  amountDueCents: number
  overdue: boolean
}

type InvoiceForClient = Pick<
  Invoice,
  'kind' | 'status' | 'totalInclTaxCents' | 'paidCents' | 'creditedCents' | 'dueDate'
>

/**
 * État d'une facture émise pour le client, au jour `today` du centre
 * (`YYYY-MM-DD`). Échue : son échéance est passée — le jour de l'échéance
 * lui-même, elle ne l'est pas encore.
 */
export function clientInvoiceState(invoice: InvoiceForClient, today: string): ClientInvoiceState {
  if (invoice.kind === 'credit_note') {
    return { tone: 'credit', label: 'Avoir', amountDueCents: 0, overdue: false }
  }
  if (invoice.status === 'cancelled') {
    return { tone: 'cancelled', label: 'Annulée par avoir', amountDueCents: 0, overdue: false }
  }
  const due = amountDueCents(invoice)
  // Un brouillon n'atteint jamais l'espace client (portée client en RLS) ; s'il
  // y arrivait, il ne demanderait rien.
  if (invoice.status === 'draft' || invoice.status === 'paid' || due <= 0) {
    return { tone: 'settled', label: 'Payée', amountDueCents: 0, overdue: false }
  }
  const overdue = invoice.dueDate !== null && invoice.dueDate < today
  if (overdue) {
    return {
      tone: 'overdue',
      label: invoice.paidCents > 0 ? 'Échue, payée en partie' : 'Échue',
      amountDueCents: due,
      overdue,
    }
  }
  return invoice.paidCents > 0
    ? { tone: 'partial', label: 'Payée en partie', amountDueCents: due, overdue }
    : { tone: 'due', label: 'À régler', amountDueCents: due, overdue }
}

/**
 * Portés par les bleus de marque (ADR 004) : une facture à régler n'est pas
 * une erreur. Toujours accompagnés du libellé et d'une icône.
 */
export const clientInvoiceToneStyles: Record<ClientInvoiceTone, string> = {
  due: 'bg-accent/15 text-primary',
  overdue: 'bg-primary text-primary-foreground',
  partial: 'border border-primary bg-white text-primary',
  settled: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
  credit: 'bg-muted text-foreground',
}

/**
 * Ce qui reste à régler sur un ensemble de factures, et la part échue : le
 * résumé en tête de « Mes factures ». Par devise, pour ne jamais additionner
 * des euros et des francs suisses.
 */
export function outstandingByCurrency(
  invoices: readonly (InvoiceForClient & Pick<Invoice, 'currency'>)[],
  today: string,
): { currency: string; dueCents: number; overdueCents: number; count: number }[] {
  const totals = new Map<string, { currency: string; dueCents: number; overdueCents: number; count: number }>()
  for (const invoice of invoices) {
    const state = clientInvoiceState(invoice, today)
    if (state.amountDueCents <= 0) continue
    const total = totals.get(invoice.currency) ?? {
      currency: invoice.currency,
      dueCents: 0,
      overdueCents: 0,
      count: 0,
    }
    total.dueCents += state.amountDueCents
    if (state.overdue) total.overdueCents += state.amountDueCents
    total.count += 1
    totals.set(invoice.currency, total)
  }
  return [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1))
}
