import { toWallClock } from '../../lib/dates.ts'
import { centsToInput } from '../facturation/tarifs.ts'
import { mailKindLabels, mailRequestKindLabels, openingOriginLabels } from './labels.ts'
import { openingOrigin, type ClientOpenings } from './regles.ts'

/**
 * Export du relevé du courrier, pour la facturation dans Dolibarr (ADR 046) :
 * une ligne par prestation — ouverture, numérisation demandée, réexpédition
 * (ADR 037). Une ouverture demandée n'y figure qu'une fois, par son pli.
 *
 * Point-virgule, dates en jour/mois/année et BOM UTF-8 : c'est ce qu'un
 * tableur réglé en français ouvre d'un double-clic, sans assistant d'import ni
 * accents cassés.
 */
const COLUMNS = [
  'Client',
  'SIRET',
  'Prestation',
  'Fait le',
  'Origine',
  'Demandé par',
  'Demandé le',
  'Fait par',
  'Type',
  'Expéditeur',
  'Reçu le',
  'Pages',
  'Pages à facturer',
  'Frais d’affranchissement',
] as const

/** « 30/09/2026 10:12 », heure du centre. */
function csvDateTime(instant: Date | null, timeZone: string): string {
  if (!instant) return ''
  const [date, time] = toWallClock(instant, timeZone).split('T')
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year} ${time}`
}

/**
 * Une cellule. Les valeurs qui commencent comme une formule sont neutralisées :
 * un expéditeur saisi « =HYPERLINK(…) » ne doit pas s'exécuter à l'ouverture
 * dans le tableur.
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** « 4,50 » : un montant que le tableur lit comme un nombre ; la devise s'ajoute si ce n'est pas l'euro. */
function csvAmount(cents: number | null, currency: string | null): string {
  if (cents === null) return ''
  return currency && currency !== 'EUR' ? `${centsToInput(cents)} ${currency}` : centsToInput(cents)
}

export function openingsToCsv(groups: ClientOpenings[], timeZone: string): string {
  const rows = [COLUMNS.join(';')]
  for (const group of groups) {
    // Ouvertures et demandes du client mêlées, dans l'ordre où elles ont été faites.
    const lines: { at: Date; cells: (string | null)[] }[] = [
      ...group.lines.map((line) => ({
        at: line.openedAt,
        cells: [
          line.clientName,
          line.clientSiret,
          mailRequestKindLabels.open_and_scan,
          csvDateTime(line.openedAt, timeZone),
          openingOriginLabels[openingOrigin(line)],
          line.requestedBy,
          csvDateTime(line.openingRequestedAt, timeZone),
          line.openedBy,
          mailKindLabels[line.kind],
          line.sender,
          csvDateTime(line.receivedAt, timeZone),
          line.pageCount === null ? '' : String(line.pageCount),
          String(line.billablePages),
          '',
        ],
      })),
      ...group.requests.map((request) => ({
        at: request.completedAt,
        cells: [
          request.clientName,
          request.clientSiret,
          mailRequestKindLabels[request.kind],
          csvDateTime(request.completedAt, timeZone),
          openingOriginLabels[request.requestedByClient ? 'client' : 'centre'],
          request.requestedBy,
          csvDateTime(request.requestedAt, timeZone),
          request.completedBy,
          mailKindLabels[request.mailKind],
          request.sender,
          csvDateTime(request.receivedAt, timeZone),
          request.pageCount === null ? '' : String(request.pageCount),
          // Une numérisation demandée se facture par sa demande, jamais à la page (ADR 044).
          request.kind === 'scan' ? '0' : '',
          csvAmount(request.postageCents, request.postageCurrency),
        ],
      })),
    ]
    lines.sort((a, b) => a.at.getTime() - b.at.getTime())
    for (const line of lines) rows.push(line.cells.map(csvCell).join(';'))
  }
  return `﻿${rows.join('\r\n')}\r\n`
}
