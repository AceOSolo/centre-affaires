import { toIsoDate } from '../../lib/dates.ts'
import type { MailKind, MailRequestKind, MailStatus } from './schema.ts'

/**
 * Règles du courrier (ADR 015). Sans base ni framework, pour être éprouvées
 * seules : ce sont elles qui décident de ce qui est facturé.
 *
 * Les requêtes rejouent chaque transition dans leur `where` — la règle dit ce
 * qui est permis, la base garantit que deux clics simultanés n'en font pas
 * deux.
 */

/** Le client ne peut demander l'ouverture que d'un pli encore fermé et sans demande. */
export function canRequestOpening(status: MailStatus): boolean {
  return status === 'received'
}

/**
 * Une demande s'annule tant que le centre n'a pas ouvert le pli. Après, la
 * prestation est faite : il n'y a plus rien à annuler.
 */
export function canCancelOpeningRequest(status: MailStatus): boolean {
  return status === 'opening_requested'
}

/**
 * Le centre ouvre un pli demandé, ou de lui-même un pli fermé — un contrat qui
 * prévoit la numérisation systématique, une consigne donnée par téléphone. Un
 * pli ne s'ouvre qu'une fois : c'est ce qui rend le relevé juste.
 */
export function canOpen(status: MailStatus): boolean {
  return status !== 'opened'
}

/** Qui a déclenché l'ouverture : le client depuis son espace, ou le centre. */
export type OpeningOrigin = 'client' | 'centre'

export function openingOrigin(item: { openingRequestedAt: Date | null }): OpeningOrigin {
  return item.openingRequestedAt ? 'client' : 'centre'
}

/** Une ouverture telle qu'elle figure au relevé de facturation. */
export type OpeningLine = {
  mailItemId: string
  clientId: string
  clientName: string
  clientSiret: string | null
  kind: MailKind
  sender: string | null
  receivedAt: Date
  openingRequestedAt: Date | null
  requestedBy: string | null
  openedAt: Date
  openedBy: string | null
  /** Pages du contenu numérisé à l'ouverture (ADR 044) ; nul s'il n'est pas compté. */
  pageCount: number | null
  /** Pages à facturer : au-delà de celles comprises dans l'ouverture (`billablePages`). */
  billablePages: number
}

export type ClientOpenings = {
  clientId: string
  clientName: string
  clientSiret: string | null
  total: number
  /** Dont celles demandées depuis l'espace client. */
  requestedByClient: number
  /** Pages numérisées, et celles à facturer au-delà des pages comprises (ADR 044). */
  pages: number
  billablePages: number
  lines: OpeningLine[]
}

/**
 * Relevé des ouvertures, regroupé par client : ce que le centre reporte sur la
 * facture de chacun.
 *
 * Clients par ordre alphabétique, ouvertures par ordre chronologique — l'ordre
 * dans lequel on vérifie une facture ligne à ligne.
 */
export function groupOpeningsByClient(lines: OpeningLine[]): ClientOpenings[] {
  const groups = new Map<string, ClientOpenings>()

  for (const line of lines) {
    let group = groups.get(line.clientId)
    if (!group) {
      group = {
        clientId: line.clientId,
        clientName: line.clientName,
        clientSiret: line.clientSiret,
        total: 0,
        requestedByClient: 0,
        pages: 0,
        billablePages: 0,
        lines: [],
      }
      groups.set(line.clientId, group)
    }
    group.total += 1
    group.pages += line.pageCount ?? 0
    group.billablePages += line.billablePages
    if (openingOrigin(line) === 'client') group.requestedByClient += 1
    group.lines.push(line)
  }

  const sorted = [...groups.values()].sort((a, b) =>
    a.clientName.localeCompare(b.clientName, 'fr', { sensitivity: 'base' }),
  )
  for (const group of sorted) {
    group.lines.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
  }
  return sorted
}

/**
 * Pages facturées pour un contenu numérisé (ADR 044) : celles au-delà des
 * pages comprises dans l'ouverture (`tenants.mail_opening_included_pages`).
 * Un contenu sans compte de pages (déposé avant le compteur) n'en facture
 * aucune : rien n'est inventé.
 */
export function billablePages(pageCount: number | null, includedPages: number): number {
  if (pageCount === null || pageCount <= 0) return 0
  return Math.max(0, pageCount - Math.max(0, includedPages))
}

/**
 * L'instant qui place un contenu numérisé au relevé du mois : la fin de la
 * numérisation demandée qui l'a produit (ADR 037), sinon l'ouverture du pli —
 * d'office ou sur demande d'ouverture. Nul si rien ne le date.
 */
export function scanReportedAt(
  request: { kind: MailRequestKind; completedAt: Date | null } | null | undefined,
  openedAt: Date | null,
): Date | null {
  return request?.kind === 'scan' ? request.completedAt : openedAt
}

/**
 * Le nombre de pages d'un contenu se corrige tant que le mois où il figure au
 * relevé n'est pas terminé, en mois civil du centre. Ensuite, le relevé a pu
 * être reporté dans Dolibarr (ADR 046) : la correction se fait là-bas, et le
 * relevé du site ne change plus en silence. La base tient la même règle
 * (`mail_scans_before_update`, `CA017`).
 */
export function canCorrectPages(reportedAt: Date | null, now: Date, timeZone: string): boolean {
  if (!reportedAt) return true
  return toIsoDate(reportedAt, timeZone).slice(0, 7) >= toIsoDate(now, timeZone).slice(0, 7)
}
