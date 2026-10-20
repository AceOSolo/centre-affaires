import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { groupOpeningsByClient, type RequestLine } from './regles.ts'
import { csvCell, openingsToCsv } from './releve.ts'

describe('export du relevé', () => {
  const releve = groupOpeningsByClient([
    {
      mailItemId: 'm1',
      clientId: 'c1',
      clientName: 'Atelier Durand',
      clientSiret: '12345678900012',
      kind: 'recommande',
      sender: 'Impots; service des entreprises',
      receivedAt: new Date('2026-09-30T20:00:00Z'),
      openingRequestedAt: new Date('2026-09-30T21:00:00Z'),
      requestedBy: 'Jeanne Durand',
      // 1er octobre 0h30 à Paris : c'est l'heure du centre qui figure au relevé.
      openedAt: new Date('2026-09-30T22:30:00Z'),
      openedBy: 'Camille',
      pageCount: 12,
      billablePages: 7,
    },
  ])

  it('ouvre dans un tableur français : BOM, point-virgule, fins de ligne CRLF', () => {
    const csv = openingsToCsv(releve, 'Europe/Paris')
    assert.ok(csv.startsWith('﻿Client;SIRET;Prestation;Fait le;'))
    assert.equal(csv.split('\r\n').length, 3)
  })

  it('écrit les dates à l’heure du centre', () => {
    const [, ligne] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(
      ligne,
      /;Ouverture et numérisation;01\/10\/2026 00:30;Demande du client;Jeanne Durand;30\/09\/2026 23:00;/,
    )
  })

  it('porte les pages numérisées et celles à facturer (ADR 044)', () => {
    const [entete, ligne] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(entete, /;Pages;Pages à facturer;Frais d’affranchissement$/)
    assert.match(ligne, /;12;7;$/)
    assert.equal(releve[0].pages, 12)
    assert.equal(releve[0].billablePages, 7)
  })

  it('protège une valeur qui contient le séparateur', () => {
    const [, ligne] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(ligne, /;"Impots; service des entreprises";/)
  })

  it('neutralise une valeur qui commencerait une formule', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
    assert.equal(csvCell('+33 1 23'), "'+33 1 23")
    assert.equal(csvCell(null), '')
  })
})

describe('export du relevé : numérisations demandées et réexpéditions (ADR 037, 046)', () => {
  const demande = (overrides: Partial<RequestLine>): RequestLine => ({
    mailRequestId: 'r1',
    mailItemId: 'm1',
    clientId: 'c1',
    clientName: 'Atelier Durand',
    clientSiret: '12345678900012',
    kind: 'scan',
    mailKind: 'lettre',
    sender: 'URSSAF',
    receivedAt: new Date('2026-10-01T08:00:00Z'),
    requestedAt: new Date('2026-10-05T08:00:00Z'),
    requestedBy: 'Jeanne Durand',
    requestedByClient: true,
    completedAt: new Date('2026-10-05T10:00:00Z'),
    completedBy: 'Camille',
    pageCount: null,
    postageCents: null,
    postageCurrency: null,
    ...overrides,
  })

  const releve = groupOpeningsByClient(
    [
      {
        mailItemId: 'm1',
        clientId: 'c1',
        clientName: 'Atelier Durand',
        clientSiret: '12345678900012',
        kind: 'lettre',
        sender: 'URSSAF',
        receivedAt: new Date('2026-10-01T08:00:00Z'),
        openingRequestedAt: null,
        requestedBy: null,
        openedAt: new Date('2026-10-02T08:00:00Z'),
        openedBy: 'Camille',
        pageCount: 3,
        billablePages: 0,
      },
    ],
    [
      demande({ mailRequestId: 'reexp', kind: 'forward', completedAt: new Date('2026-10-20T09:00:00Z'), postageCents: 450, postageCurrency: 'EUR' }),
      demande({ mailRequestId: 'scan', kind: 'scan', pageCount: 4 }),
      demande({ mailRequestId: 'autre', clientId: 'c2', clientName: 'Boulangerie Petit', kind: 'forward' }),
    ],
  )

  it('regroupe les demandes faites par client, à côté des ouvertures', () => {
    assert.deepEqual(
      releve.map((groupe) => [groupe.clientName, groupe.total, groupe.scans, groupe.forwards]),
      [
        ['Atelier Durand', 1, 1, 1],
        // Un client sans ouverture figure au relevé pour ses seules demandes.
        ['Boulangerie Petit', 0, 0, 1],
      ],
    )
    assert.deepEqual(
      releve[0].requests.map((ligne) => ligne.mailRequestId),
      ['scan', 'reexp'],
    )
  })

  it('ne compte pas les pages d’une numérisation demandée avec celles des ouvertures', () => {
    // Elle se facture par sa demande, jamais à la page (ADR 044).
    assert.equal(releve[0].pages, 3)
    assert.equal(releve[0].billablePages, 0)
  })

  it('écrit une ligne par prestation, dans l’ordre où elles ont été faites', () => {
    const lignes = openingsToCsv(releve, 'Europe/Paris').split('\r\n').slice(1, -1)
    assert.deepEqual(
      lignes.map((ligne) => ligne.split(';').slice(0, 4)),
      [
        ['Atelier Durand', '12345678900012', 'Ouverture et numérisation', '02/10/2026 10:00'],
        ['Atelier Durand', '12345678900012', 'Numérisation', '05/10/2026 12:00'],
        ['Atelier Durand', '12345678900012', 'Réexpédition', '20/10/2026 11:00'],
        ['Boulangerie Petit', '12345678900012', 'Réexpédition', '05/10/2026 12:00'],
      ],
    )
  })

  it('porte les pages d’une numérisation demandée, rien à facturer à la page', () => {
    const [, , numerisation] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(numerisation, /;Demande du client;Jeanne Durand;05\/10\/2026 10:00;Camille;Lettre;URSSAF;/)
    assert.match(numerisation, /;4;0;$/)
  })

  it('porte les frais d’affranchissement relevés d’une réexpédition, vides tant qu’ils ne le sont pas', () => {
    const [, , , reexpedition, autre] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(reexpedition, /;;;4,50$/)
    assert.match(autre, /;;;$/)
  })
})
