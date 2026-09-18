import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatOpeningSummary, type OpeningRule } from './ouverture.ts'

const regle = (
  weekday: number,
  opensAt: string,
  closesAt: string,
  resourceId: string | null = null,
): OpeningRule => ({ resourceId, weekday, opensAt, closesAt })

const SEMAINE = [1, 2, 3, 4, 5].map((jour) => regle(jour, '08:00:00', '18:00:00'))

describe('résumé des horaires d’ouverture', () => {
  it('regroupe les jours consécutifs aux mêmes horaires', () => {
    assert.equal(formatOpeningSummary(SEMAINE), 'Du lundi au vendredi, 8h00 – 18h00')
  })

  it('sépare un jour aux horaires différents', () => {
    const avecSamedi = [...SEMAINE, regle(6, '09:00:00', '12:00:00')]
    assert.equal(
      formatOpeningSummary(avecSamedi),
      'Du lundi au vendredi, 8h00 – 18h00 · Le samedi, 9h00 – 12h00',
    )
  })

  it('ne regroupe pas des jours non consécutifs', () => {
    // Fermé le mercredi : lundi-mardi et jeudi-vendredi sont deux groupes.
    const sansMercredi = SEMAINE.filter((r) => r.weekday !== 3)
    assert.equal(
      formatOpeningSummary(sansMercredi),
      'Le lundi et le mardi, 8h00 – 18h00 · Le jeudi et le vendredi, 8h00 – 18h00',
    )
  })

  it('énonce les deux plages d’une journée coupée', () => {
    const coupee = [regle(1, '08:00:00', '12:00:00'), regle(1, '14:00:00', '18:00:00')]
    assert.equal(formatOpeningSummary(coupee), 'Le lundi, 8h00 – 12h00 et 14h00 – 18h00')
  })

  it('n’invente pas d’horaires quand il n’y en a aucun', () => {
    assert.equal(formatOpeningSummary([]), undefined)
  })

  it('préfère les règles de la ressource à celles du centre', () => {
    // Les règles d'une ressource remplacent celles du centre, elles ne s'y
    // ajoutent pas — même contrat que `rulesForResource`.
    const SALLE = 'resource-salle'
    const melange = [...SEMAINE, regle(6, '10:00:00', '16:00:00', SALLE)]
    assert.equal(formatOpeningSummary(melange, SALLE), 'Le samedi, 10h00 – 16h00')
    assert.equal(formatOpeningSummary(melange), 'Du lundi au vendredi, 8h00 – 18h00')
  })

  it('met les minutes sur deux chiffres', () => {
    assert.equal(formatOpeningSummary([regle(1, '08:05:00', '17:30:00')]), 'Le lundi, 8h05 – 17h30')
  })
})
