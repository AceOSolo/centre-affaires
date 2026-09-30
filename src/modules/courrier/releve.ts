import { toWallClock } from '../../lib/dates.ts'
import { mailKindLabels, openingOriginLabels } from './labels.ts'
import { openingOrigin, type ClientOpenings } from './regles.ts'

/**
 * Export du relevé des ouvertures, pour la facturation.
 *
 * Point-virgule, dates en jour/mois/année et BOM UTF-8 : c'est ce qu'un
 * tableur réglé en français ouvre d'un double-clic, sans assistant d'import ni
 * accents cassés.
 */
const COLUMNS = [
  'Client',
  'SIRET',
  'Ouvert le',
  'Origine',
  'Demandé par',
  'Demandé le',
  'Ouvert par',
  'Type',
  'Expéditeur',
  'Reçu le',
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

export function openingsToCsv(groups: ClientOpenings[], timeZone: string): string {
  const rows = [COLUMNS.join(';')]
  for (const group of groups) {
    for (const line of group.lines) {
      rows.push(
        [
          line.clientName,
          line.clientSiret,
          csvDateTime(line.openedAt, timeZone),
          openingOriginLabels[openingOrigin(line)],
          line.requestedBy,
          csvDateTime(line.openingRequestedAt, timeZone),
          line.openedBy,
          mailKindLabels[line.kind],
          line.sender,
          csvDateTime(line.receivedAt, timeZone),
        ]
          .map(csvCell)
          .join(';'),
      )
    }
  }
  return `﻿${rows.join('\r\n')}\r\n`
}
