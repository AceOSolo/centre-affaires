import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  attributeFields,
  formatAttributeValue,
  hasCapacity,
  mergeAttributes,
  normalisePlate,
  parseAttributes,
  parseResourceInput,
} from './attributs.ts'
import { describeAttributes } from './labels.ts'
import { resourceTypes } from './schema.ts'

/** Lecteur de formulaire à partir d'un objet : ce qu'un `FormData` rendrait. */
const form =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? ''

describe('parseAttributes', () => {
  it('décrit des champs pour chaque type, aucun pour la boîte aux lettres', () => {
    for (const type of resourceTypes) assert.ok(Array.isArray(attributeFields[type]))
    assert.equal(attributeFields.boite_aux_lettres.length, 0)
    assert.deepEqual(parseAttributes('boite_aux_lettres', form({ numero: '12' })), {
      attributes: {},
      errors: {},
    })
  })

  it('exige le numéro du casier et garde sa taille', () => {
    assert.deepEqual(parseAttributes('casier', form({ taille: 'M' })).errors, {
      numero: 'Ce champ est obligatoire.',
    })
    assert.deepEqual(parseAttributes('casier', form({ numero: ' 12 ', taille: 'l' })), {
      attributes: { numero: '12', taille: 'L' },
      errors: {},
    })
  })

  it('refuse une taille de casier hors S, M, L', () => {
    assert.equal(
      parseAttributes('casier', form({ numero: '3', taille: 'XL' })).errors.taille,
      'Valeur attendue : S, M, L.',
    )
  })

  it('refuse un numéro de casier trop long', () => {
    assert.ok(parseAttributes('casier', form({ numero: '1'.repeat(21) })).errors.numero)
  })

  it('lit une superficie décimale à la française et l’arrondit au centième', () => {
    assert.deepEqual(parseAttributes('bureau', form({ superficieM2: '12,456', postes: '3' })), {
      attributes: { superficieM2: 12.46, postes: 3 },
      errors: {},
    })
  })

  it('refuse un nombre de postes non entier, nul ou négatif', () => {
    assert.equal(
      parseAttributes('bureau', form({ postes: '2,5' })).errors.postes,
      'Un nombre entier est attendu.',
    )
    assert.equal(parseAttributes('bureau', form({ postes: '0' })).errors.postes, 'Au moins 1.')
    assert.equal(
      parseAttributes('bureau', form({ postes: '-2' })).errors.postes,
      'Un nombre entier est attendu.',
    )
  })

  it('omet les champs facultatifs laissés vides plutôt que de les ranger à null', () => {
    assert.deepEqual(parseAttributes('salle', form({})), { attributes: {}, errors: {} })
  })

  it('ignore les champs qui ne sont pas ceux du type', () => {
    assert.deepEqual(parseAttributes('salle', form({ postes: '4', kilometrage: '10' })).attributes, {})
  })

  it('découpe les équipements, sans doublon ni élément vide', () => {
    assert.deepEqual(
      parseAttributes('salle', form({ equipements: 'Wifi, écran,, wifi , paperboard' })).attributes,
      { equipements: ['Wifi', 'écran', 'paperboard'] },
    )
  })

  it('normalise l’immatriculation et tolère les espaces de milliers au kilométrage', () => {
    assert.deepEqual(
      parseAttributes('vehicule', form({ immatriculation: 'ab 123 cd', kilometrage: '120 000', places: '5' })),
      { attributes: { immatriculation: 'AB-123-CD', kilometrage: 120_000, places: 5 }, errors: {} },
    )
  })

  it('refuse une immatriculation hors format SIV et des places impossibles', () => {
    const { errors } = parseAttributes('vehicule', form({ immatriculation: '123 ABC 75', places: '0' }))
    assert.equal(errors.immatriculation, 'Immatriculation attendue au format AB-123-CD.')
    assert.equal(errors.places, 'Au moins 1.')
  })
})

describe('normalisePlate', () => {
  it('rend la forme à tirets, quelle que soit la saisie', () => {
    assert.equal(normalisePlate('AB123CD'), 'AB-123-CD')
    assert.equal(normalisePlate('ab-123-cd'), 'AB-123-CD')
    assert.equal(normalisePlate('AB-12-CD'), undefined)
  })
})

describe('parseResourceInput', () => {
  const salle = {
    resourceType: 'salle',
    code: 'S-101',
    name: 'Salle Europe',
    capacity: '12',
    status: 'active',
    superficieM2: '30',
    description: '',
  }

  it('rend une saisie complète et typée', () => {
    assert.deepEqual(parseResourceInput(form(salle)), {
      ok: true,
      input: {
        resourceType: 'salle',
        code: 'S-101',
        name: 'Salle Europe',
        description: null,
        capacity: 12,
        status: 'active',
        attributes: { superficieM2: 30 },
      },
    })
  })

  it('rassemble toutes les erreurs, champs communs et attributs ensemble', () => {
    const parsed = parseResourceInput(form({ resourceType: 'bureau', capacity: 'beaucoup', postes: '0' }))
    assert.equal(parsed.ok, false)
    assert.deepEqual(Object.keys(parsed.ok ? {} : parsed.errors).sort(), [
      'capacity',
      'code',
      'name',
      'postes',
    ])
  })

  it('refuse un type inconnu', () => {
    const parsed = parseResourceInput(form({ ...salle, resourceType: 'parking' }))
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.errors.resourceType, 'Type de ressource inconnu.')
  })

  it('impose le type de la ressource modifiée, quoi que dise le formulaire', () => {
    const parsed = parseResourceInput(form({ ...salle, resourceType: 'casier', numero: '4' }), {
      resourceType: 'casier',
    })
    assert.ok(parsed.ok)
    assert.equal(parsed.input.resourceType, 'casier')
    assert.deepEqual(parsed.input.attributes, { numero: '4' })
  })

  it('ne garde aucune capacité pour un casier ou une boîte aux lettres', () => {
    assert.equal(hasCapacity('casier'), false)
    assert.equal(hasCapacity('boite_aux_lettres'), false)
    const parsed = parseResourceInput(
      form({ resourceType: 'boite_aux_lettres', code: 'DOM-01', name: 'Domiciliation 01', capacity: '3' }),
    )
    assert.ok(parsed.ok)
    assert.equal(parsed.input.capacity, null)
  })

  it('refuse une capacité nulle', () => {
    const parsed = parseResourceInput(form({ ...salle, capacity: '0' }))
    assert.equal(parsed.ok ? '' : parsed.errors.capacity, 'Au moins 1.')
  })

  it('n’accepte que les états autorisés par l’écran', () => {
    const parsed = parseResourceInput(form({ ...salle, status: 'retired' }), {
      allowedStatuses: ['active', 'maintenance'],
    })
    assert.equal(parsed.ok ? '' : parsed.errors.status, 'État inconnu.')
    assert.ok(parseResourceInput(form({ ...salle, status: 'retired' })).ok)
  })
})

describe('mergeAttributes', () => {
  it('conserve les clés inconnues du formulaire et suit la saisie pour les autres', () => {
    assert.deepEqual(
      mergeAttributes('bureau', { superficieM2: 20, postes: 2, etage: 3 }, { postes: 4 }),
      { etage: 3, postes: 4 },
    )
  })

  it('part d’un objet vide quand la ressource n’a pas d’attributs', () => {
    assert.deepEqual(mergeAttributes('casier', null, { numero: '7' }), { numero: '7' })
  })
})

describe('formatAttributeValue', () => {
  const [superficie, equipements] = attributeFields.salle

  it('met en forme nombres et listes, et signale un champ vide', () => {
    assert.equal(formatAttributeValue(superficie, 1250.5), '1 250,5'.replace(' ', ' '))
    assert.equal(formatAttributeValue(equipements, ['wifi', 'écran']), 'wifi, écran')
    assert.equal(formatAttributeValue(equipements, []), undefined)
    assert.equal(formatAttributeValue(superficie, undefined), undefined)
  })
})

describe('describeAttributes', () => {
  it('affiche le numéro du casier et une superficie au format français', () => {
    assert.equal(describeAttributes({ numero: '12', taille: 'M' }), 'n° 12 · taille M')
    assert.equal(describeAttributes({ superficieM2: 12.5 }), '12,5 m²')
  })
})
