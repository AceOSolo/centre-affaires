import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeShownPreferences, preferenceGroups, visiblePreferenceGroups, type PreferenceUsage } from './preferences-groupes.ts'
import { notificationCategories, type NotificationCategory } from './schema.ts'

const rien: PreferenceUsage = { domiciliated: false, bookings: 0, contracts: 0, inspections: 0, invoices: 0 }
const titres = (usage: PreferenceUsage) => visiblePreferenceGroups(usage).map((group) => group.title)

const form = (fields: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const value = fields[name]
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
  },
  getAll: (name: string) => {
    const value = fields[name]
    return Array.isArray(value) ? value : value === undefined ? [] : [value]
  },
})

describe('préférences rangées par service (ADR 077)', () => {
  it('range chaque catégorie dans un groupe, une seule fois', () => {
    const rangees = preferenceGroups.flatMap((group) => group.categories)
    assert.deepEqual([...rangees].sort(), [...notificationCategories].sort())
    assert.equal(new Set(rangees).size, rangees.length)
  })

  it('ne montre à un nouveau client que les informations du centre', () => {
    assert.deepEqual(titres(rien), ['Informations du centre'])
  })

  it('montre le courrier à un domicilié, avec l’avis « pas de courrier »', () => {
    const groupes = visiblePreferenceGroups({ ...rien, domiciliated: true })
    assert.deepEqual(groupes.map((group) => group.title), ['Courrier', 'Informations du centre'])
    assert.deepEqual(groupes[0]?.categories, ['mail', 'mail_none'])
  })

  it('montre chaque service utilisé, dans l’ordre des rubriques de l’espace', () => {
    assert.deepEqual(titres({ domiciliated: true, bookings: 2, contracts: 1, inspections: 1, invoices: 3 }), [
      'Courrier',
      'Réservations',
      'Contrats',
      'États des lieux',
      'Factures',
      'Informations du centre',
    ])
    assert.deepEqual(titres({ ...rien, bookings: 1 }), ['Réservations', 'Informations du centre'])
  })
})

describe('enregistrement des cases montrées seulement', () => {
  const actuel = Object.fromEntries(notificationCategories.map((category) => [category, true])) as Record<
    NotificationCategory,
    boolean
  >

  it('prend la valeur du formulaire pour les cases montrées, cochées ou non', () => {
    const fusion = mergeShownPreferences(actuel, form({ categorie: ['mail', 'mail_none', 'centre_info'], mail: 'on' }))
    assert.equal(fusion.mail, true)
    assert.equal(fusion.mail_none, false)
    assert.equal(fusion.centre_info, false)
  })

  it('garde le réglage d’un groupe caché, même refusé auparavant', () => {
    const fusion = mergeShownPreferences({ ...actuel, bookings: false }, form({ categorie: ['centre_info'], centre_info: 'on' }))
    assert.equal(fusion.bookings, false)
    assert.equal(fusion.invoices, true)
    assert.equal(fusion.centre_info, true)
  })

  it('ignore une catégorie inconnue', () => {
    const fusion = mergeShownPreferences(actuel, form({ categorie: ['inconnue'], inconnue: 'on' }))
    assert.deepEqual(fusion, actuel)
  })
})
