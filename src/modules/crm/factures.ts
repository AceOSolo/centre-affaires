import { isCalendarDate } from '../../lib/dates.ts'
import { readCrmId, type Read } from '../clients/tiers-crm.ts'
import type { CrmInvoiceKind, CrmInvoiceStatus } from './schema-factures.ts'

/**
 * Factures émises par le CRM, reçues pour l'espace client (ADR 081) : lecture
 * de l'envoi `POST /api/dolibarr/factures`, et ce que l'espace client en dit.
 * Règles pures ; `factures-queries.ts` les applique.
 *
 * Le site ne facture rien (ADR 046) : il garde une copie de lecture de ce que
 * le CRM a émis. Montants en centimes (décision 5), dates de calendrier du
 * centre, lien du PDF chez le CRM.
 */

/** Type de pièce, dans l'API. */
export const crmInvoiceKindWords: Record<string, CrmInvoiceKind> = {
  facture: 'invoice',
  avoir: 'credit_note',
}

/**
 * État, dans l'API. « brouillon » se lit comme une suppression : une facture
 * repassée en brouillon dans le CRM quitte l'espace client jusqu'à sa
 * nouvelle validation.
 */
export const crmInvoiceStatusWords: Record<string, CrmInvoiceStatus | 'removed'> = {
  a_payer: 'unpaid',
  payee: 'paid',
  abandonnee: 'cancelled',
  brouillon: 'removed',
}

export type ReceivedInvoiceFields = {
  number: string
  kind: CrmInvoiceKind
  status: CrmInvoiceStatus
  issuedOn: string
  dueOn: string | null
  totalExclTaxCents: number
  totalInclTaxCents: number
  amountDueCents: number | null
  currency: string
  pdfUrl: string | null
}

export type ReceivedInvoice =
  | { removed: true; crmId: string }
  | {
      removed: false
      crmId: string
      /** Identifiant du tiers dans le CRM : il doit être déjà reçu (flux Tiers). */
      thirdPartyCrmId: string
      fields: ReceivedInvoiceFields
    }

/** Longueur maximale du lien du PDF (`crm_invoices.pdf_url`). */
export const PDF_URL_MAX_LENGTH = 1000

/** Un montant en centimes : un entier, de signe quelconque, que la lecture borne ensuite. */
function readCents(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2_000_000_000 ? value : undefined
}

/**
 * Le lien du PDF : une adresse https, sans identifiant ni mot de passe, qui
 * s'ouvre dans le navigateur du client. `undefined` : illisible.
 */
export function readPdfUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length > PDF_URL_MAX_LENGTH || /[\s\p{Cc}]/u.test(text)) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined
  return text
}

/** Lit l'envoi `POST /api/dolibarr/factures`. Le message dit quel champ corriger. */
export function readCrmInvoice(body: unknown): Read<ReceivedInvoice> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Corps illisible : un objet JSON est attendu.' }
  }
  const input = body as Record<string, unknown>
  const crmId = readCrmId(input.dolibarrId)
  if (!crmId) return { ok: false, message: '« dolibarrId » est obligatoire (64 caractères au plus) : l’identifiant de la facture.' }
  if (input.supprime !== undefined && typeof input.supprime !== 'boolean') {
    return { ok: false, message: '« supprime » vaut true ou false.' }
  }
  if (input.supprime === true) return { ok: true, value: { removed: true, crmId } }

  if (typeof input.statut !== 'string' || !Object.hasOwn(crmInvoiceStatusWords, input.statut)) {
    return { ok: false, message: '« statut » vaut « a_payer », « payee », « abandonnee » ou « brouillon ».' }
  }
  const status = crmInvoiceStatusWords[input.statut]!
  if (status === 'removed') return { ok: true, value: { removed: true, crmId } }

  const thirdPartyCrmId = readCrmId(input.tiersDolibarrId)
  if (!thirdPartyCrmId) return { ok: false, message: '« tiersDolibarrId » est obligatoire : le tiers de la facture.' }

  const number = typeof input.numero === 'string' ? input.numero.replace(/[\p{Cc}]+/gu, ' ').trim() : ''
  if (!number || number.length > 64) {
    return { ok: false, message: '« numero » est obligatoire (64 caractères au plus) : la référence de la facture.' }
  }

  const kindWord = input.type === undefined || input.type === null ? 'facture' : input.type
  if (typeof kindWord !== 'string' || !Object.hasOwn(crmInvoiceKindWords, kindWord)) {
    return { ok: false, message: '« type » vaut « facture » ou « avoir ».' }
  }
  const kind = crmInvoiceKindWords[kindWord]!

  if (typeof input.date !== 'string' || !isCalendarDate(input.date)) {
    return { ok: false, message: '« date » est obligatoire : la date de la facture, AAAA-MM-JJ.' }
  }
  const issuedOn = input.date
  let dueOn: string | null = null
  if (input.echeance !== undefined && input.echeance !== null && input.echeance !== '') {
    if (typeof input.echeance !== 'string' || !isCalendarDate(input.echeance)) {
      return { ok: false, message: '« echeance » : une date AAAA-MM-JJ, ou null.' }
    }
    if (input.echeance < issuedOn) return { ok: false, message: '« echeance » précède « date ».' }
    dueOn = input.echeance
  }

  let totalExcl = readCents(input.montantHtCentimes)
  let totalIncl = readCents(input.montantTtcCentimes)
  if (totalExcl === undefined || totalIncl === undefined) {
    return { ok: false, message: '« montantHtCentimes » et « montantTtcCentimes » sont obligatoires : des entiers, en centimes.' }
  }
  if (kind === 'credit_note') {
    // Dolibarr tient un avoir en négatif : son sens est dans « type ».
    totalExcl = Math.abs(totalExcl)
    totalIncl = Math.abs(totalIncl)
  } else if (totalExcl < 0 || totalIncl < 0) {
    return { ok: false, message: 'Une facture a des montants positifs ; un avoir s’envoie avec « type » : « avoir ».' }
  }

  let amountDueCents: number | null = null
  if (input.resteAPayerCentimes !== undefined && input.resteAPayerCentimes !== null) {
    const due = readCents(input.resteAPayerCentimes)
    if (due === undefined || due < 0) return { ok: false, message: '« resteAPayerCentimes » : un entier positif, en centimes, ou null.' }
    if (due > totalIncl) return { ok: false, message: '« resteAPayerCentimes » dépasse « montantTtcCentimes ».' }
    // Le reste à payer ne dit rien d'un avoir ni d'une facture abandonnée.
    if (kind === 'invoice' && status === 'unpaid') amountDueCents = due
    else if (kind === 'invoice' && status === 'paid' && due > 0) {
      return { ok: false, message: 'Une facture « payee » n’a plus rien à payer : « resteAPayerCentimes » vaut 0 ou null.' }
    }
  }

  const currency = input.devise === undefined || input.devise === null ? 'EUR' : input.devise
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, message: '« devise » : un code ISO 4217 en capitales (EUR).' }
  }

  const pdfUrl = readPdfUrl(input.pdf)
  if (pdfUrl === undefined) {
    return {
      ok: false,
      message: `« pdf » : l’adresse https de téléchargement du PDF (${PDF_URL_MAX_LENGTH} caractères au plus, sans identifiant), ou null.`,
    }
  }

  return {
    ok: true,
    value: {
      removed: false,
      crmId,
      thirdPartyCrmId,
      fields: {
        number,
        kind,
        status,
        issuedOn,
        dueOn,
        totalExclTaxCents: totalExcl,
        totalInclTaxCents: totalIncl,
        amountDueCents,
        currency,
        pdfUrl,
      },
    },
  }
}

/** Les champs reçus sont-ils ceux déjà gardés ? Un envoi rejoué ne change rien. */
export function sameInvoiceFields(a: ReceivedInvoiceFields, b: ReceivedInvoiceFields): boolean {
  return (
    a.number === b.number &&
    a.kind === b.kind &&
    a.status === b.status &&
    a.issuedOn === b.issuedOn &&
    a.dueOn === b.dueOn &&
    a.totalExclTaxCents === b.totalExclTaxCents &&
    a.totalInclTaxCents === b.totalInclTaxCents &&
    a.amountDueCents === b.amountDueCents &&
    a.currency === b.currency &&
    a.pdfUrl === b.pdfUrl
  )
}

/* ------------------------------------------------------------------------ */
/* Ce que l'espace client en dit                                            */
/* ------------------------------------------------------------------------ */

/**
 * - `due` : à payer, échéance pas encore passée ;
 * - `overdue` : à payer, échéance passée ;
 * - `partial` : payée en partie, échéance pas encore passée ;
 * - `paid` : payée ;
 * - `cancelled` : abandonnée par le centre ;
 * - `credit` : un avoir.
 */
export type ReceivedInvoiceTone = 'due' | 'overdue' | 'partial' | 'paid' | 'cancelled' | 'credit'

export type ReceivedInvoiceState = {
  tone: ReceivedInvoiceTone
  label: string
  /** Reste à payer TTC, en centimes ; 0 quand rien n'est dû. */
  amountDueCents: number
  overdue: boolean
}

type InvoiceForState = Pick<
  ReceivedInvoiceFields,
  'kind' | 'status' | 'totalInclTaxCents' | 'amountDueCents' | 'dueOn'
>

/**
 * L'état d'une facture reçue, dit au client, au jour `today` du centre
 * (`AAAA-MM-JJ`). Échue : son échéance est passée — le jour même, elle ne
 * l'est pas encore. Sans reste à payer donné par le CRM, une facture à payer
 * l'est pour son total TTC.
 */
export function receivedInvoiceState(invoice: InvoiceForState, today: string): ReceivedInvoiceState {
  if (invoice.kind === 'credit_note') return { tone: 'credit', label: 'Avoir', amountDueCents: 0, overdue: false }
  if (invoice.status === 'cancelled') return { tone: 'cancelled', label: 'Annulée', amountDueCents: 0, overdue: false }
  const due = invoice.status === 'paid' ? 0 : (invoice.amountDueCents ?? invoice.totalInclTaxCents)
  if (due <= 0) return { tone: 'paid', label: 'Payée', amountDueCents: 0, overdue: false }
  const partial = due < invoice.totalInclTaxCents
  const overdue = invoice.dueOn !== null && invoice.dueOn < today
  if (overdue) {
    return { tone: 'overdue', label: partial ? 'Échue, payée en partie' : 'Échue', amountDueCents: due, overdue }
  }
  return partial
    ? { tone: 'partial', label: 'Payée en partie', amountDueCents: due, overdue }
    : { tone: 'due', label: 'À payer', amountDueCents: due, overdue }
}

/**
 * Portés par les bleus de marque (ADR 004) : une facture à payer n'est pas
 * une erreur. Toujours accompagnés du libellé et d'une icône.
 */
export const receivedInvoiceToneStyles: Record<ReceivedInvoiceTone, string> = {
  due: 'bg-accent/15 text-primary',
  overdue: 'bg-primary text-primary-foreground',
  partial: 'border border-primary bg-white text-primary',
  paid: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
  credit: 'bg-muted text-foreground',
}

/** Reste à payer, par devise, sur les factures montrées. */
export function outstandingReceived(
  invoices: readonly (InvoiceForState & { currency: string })[],
  today: string,
): { currency: string; dueCents: number; overdueCents: number; count: number }[] {
  const totals = new Map<string, { currency: string; dueCents: number; overdueCents: number; count: number }>()
  for (const invoice of invoices) {
    const state = receivedInvoiceState(invoice, today)
    if (state.amountDueCents <= 0) continue
    const total = totals.get(invoice.currency) ?? { currency: invoice.currency, dueCents: 0, overdueCents: 0, count: 0 }
    total.dueCents += state.amountDueCents
    if (state.overdue) total.overdueCents += state.amountDueCents
    total.count += 1
    totals.set(invoice.currency, total)
  }
  return [...totals.values()]
}
