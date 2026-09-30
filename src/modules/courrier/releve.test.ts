import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { groupOpeningsByClient } from './regles.ts'
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
    },
  ])

  it('ouvre dans un tableur français : BOM, point-virgule, fins de ligne CRLF', () => {
    const csv = openingsToCsv(releve, 'Europe/Paris')
    assert.ok(csv.startsWith('﻿Client;SIRET;Ouvert le;'))
    assert.equal(csv.split('\r\n').length, 3)
  })

  it('écrit les dates à l’heure du centre', () => {
    const [, ligne] = openingsToCsv(releve, 'Europe/Paris').split('\r\n')
    assert.match(ligne, /;01\/10\/2026 00:30;Demande du client;Jeanne Durand;30\/09\/2026 23:00;/)
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
