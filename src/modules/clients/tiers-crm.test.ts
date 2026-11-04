import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clientFieldsChanged,
  decideThirdPartyMatch,
  planContacts,
  readThirdParty,
  type ClientCandidate,
  type LinkedContact,
  type ReceivedThirdParty,
} from './tiers-crm.ts'

/**
 * Tiers reçus du CRM (ADR 066) : lecture de l'envoi, rapprochement avec les
 * fiches du site, contacts. La base est éprouvée par `tiers-crm.db.test.ts`.
 */

const envoi = (overrides: Record<string, unknown> = {}) => ({
  dolibarrId: 412,
  reference: 'CU2611-0042',
  statut: 'client',
  nom: 'Atelier Martin',
  siret: '123 456 789 00012',
  numeroTva: 'fr 12 123456789',
  email: ' Contact@Atelier-Martin.EXEMPLE.fr ',
  telephone: '0102030405',
  adresse: { ligne1: '3 rue des Lilas', codePostal: '69002', ville: 'Lyon', pays: 'fr' },
  ...overrides,
})

const lu = (overrides: Record<string, unknown> = {}) => {
  const read = readThirdParty(envoi(overrides))
  assert.equal(read.ok, true, read.ok ? undefined : read.message)
  return (read as { value: ReceivedThirdParty }).value
}

const refus = (body: unknown) => {
  const read = readThirdParty(body)
  assert.equal(read.ok, false)
  return (read as { message: string }).message
}

describe('tiers du CRM : lecture de l’envoi', () => {
  it('reprend les champs que le CRM tient, mis en forme comme sur le site', () => {
    const tiers = lu()
    assert.equal(tiers.removed, false)
    if (tiers.removed) return
    assert.equal(tiers.crmId, '412')
    assert.equal(tiers.crmRef, 'CU2611-0042')
    assert.deepEqual(tiers.fields, {
      name: 'Atelier Martin',
      legalForm: null,
      siret: '12345678900012',
      vatNumber: 'FR12123456789',
      email: 'contact@atelier-martin.exemple.fr',
      phone: '01 02 03 04 05',
      addressLine1: '3 rue des Lilas',
      addressLine2: null,
      postalCode: '69002',
      city: 'Lyon',
      country: 'FR',
      status: 'active',
    })
    assert.equal(tiers.contacts, undefined)
    assert.deepEqual(tiers.warnings, [])
  })

  it('traduit le statut : client, prospect, fermé', () => {
    const statut = (mot: string) => {
      const tiers = lu({ statut: mot })
      return tiers.removed ? undefined : tiers.fields.status
    }
    assert.equal(statut('client'), 'active')
    assert.equal(statut('prospect'), 'prospect')
    assert.equal(statut('ferme'), 'inactive')
    assert.match(refus(envoi({ statut: 'constructor' })), /statut/)
    assert.match(refus(envoi({ statut: undefined })), /statut/)
  })

  it('une suppression ne demande que l’identifiant', () => {
    assert.deepEqual(readThirdParty({ dolibarrId: '412', supprime: true }), {
      ok: true,
      value: { removed: true, crmId: '412', crmRef: null },
    })
  })

  it('refuse ce qu’il ne sait pas lire, et dit quoi corriger', () => {
    assert.match(refus(null), /objet JSON/)
    assert.match(refus(envoi({ dolibarrId: undefined })), /dolibarrId/)
    assert.match(refus(envoi({ dolibarrId: 'x'.repeat(65) })), /dolibarrId/)
    assert.match(refus(envoi({ nom: '  ' })), /nom/)
    assert.match(refus(envoi({ siret: '1234' })), /14 chiffres/)
    assert.match(refus(envoi({ siren: '12' })), /9 chiffres/)
    assert.match(refus(envoi({ siren: '999999999' })), /même entreprise/)
    assert.match(refus(envoi({ clientId: 'pas-un-uuid' })), /clientId/)
    assert.match(refus(envoi({ adresse: { pays: 'France' } })), /deux lettres/)
    assert.match(refus(envoi({ supprime: 'oui' })), /supprime/)
  })

  it('écarte une adresse électronique illisible sans bloquer le tiers', () => {
    const tiers = lu({ email: 'pas une adresse' })
    assert.equal(tiers.removed, false)
    if (tiers.removed) return
    assert.equal(tiers.fields.email, null)
    assert.deepEqual(tiers.warnings, ['Adresse électronique du tiers illisible, non reprise.'])
  })

  it('garde le SIREN seul pour le rapprochement, quand il n’y a pas de SIRET', () => {
    const tiers = lu({ siret: null, siren: '123456789' })
    assert.equal(tiers.removed, false)
    if (tiers.removed) return
    assert.equal(tiers.fields.siret, null)
    assert.equal(tiers.siren, '123456789')
  })

  it('lit les contacts, et refuse un contact sans nom ou en double', () => {
    const tiers = lu({
      contacts: [
        { dolibarrId: 88, nom: 'Camille Dupont', fonction: 'Gérante', email: 'CAMILLE@exemple.fr', facturation: true },
        { dolibarrId: '89', nom: 'Sam Leroy' },
      ],
    })
    assert.equal(tiers.removed, false)
    if (tiers.removed) return
    assert.deepEqual(tiers.contacts, [
      { crmId: '88', fullName: 'Camille Dupont', jobTitle: 'Gérante', email: 'camille@exemple.fr', phone: null, isBilling: true },
      { crmId: '89', fullName: 'Sam Leroy', jobTitle: null, email: null, phone: null, isBilling: false },
    ])
    assert.match(refus(envoi({ contacts: [{ dolibarrId: 1 }] })), /contacts\[0\].*nom/)
    assert.match(refus(envoi({ contacts: [{ dolibarrId: 1, nom: 'A' }, { dolibarrId: '1', nom: 'B' }] })), /deux fois/)
    assert.match(refus(envoi({ contacts: 'Camille' })), /liste/)
  })
})

describe('tiers du CRM : rapprochement', () => {
  const fiche = (overrides: Partial<ClientCandidate> = {}): ClientCandidate => ({
    clientId: '01999f00-0000-7000-8000-00000000c001',
    name: 'Atelier Martin',
    archived: false,
    anonymized: false,
    linkedTo: null,
    ...overrides,
  })
  const aucun = { linked: null, explicit: null, bySiret: [], bySiren: [] }

  it('retrouve d’abord la fiche déjà reliée : la référence commune est l’identifiant du CRM', () => {
    assert.deepEqual(decideThirdPartyMatch(lu(), { ...aucun, linked: fiche({ linkedTo: '412' }) }), {
      kind: 'update',
      clientId: fiche().clientId,
      how: 'link',
    })
  })

  it('refuse qu’un tiers déjà relié désigne une autre fiche', () => {
    const decision = decideThirdPartyMatch(lu({ clientId: '01999f00-0000-7000-8000-00000000c002' }), {
      ...aucun,
      linked: fiche({ linkedTo: '412' }),
    })
    assert.equal(decision.kind, 'refuse')
  })

  it('ne met plus à jour une fiche anonymisée ou archivée', () => {
    assert.equal(decideThirdPartyMatch(lu(), { ...aucun, linked: fiche({ anonymized: true, archived: true }) }).kind, 'ignore')
    assert.equal(decideThirdPartyMatch(lu(), { ...aucun, linked: fiche({ archived: true }) }).kind, 'ignore')
  })

  it('suit la fiche désignée par le CRM, si elle est libre', () => {
    const explicite = lu({ clientId: fiche().clientId })
    assert.deepEqual(decideThirdPartyMatch(explicite, { ...aucun, explicit: fiche() }), {
      kind: 'update',
      clientId: fiche().clientId,
      how: 'explicit',
    })
    assert.deepEqual(decideThirdPartyMatch(explicite, { ...aucun, explicit: 'missing' }), {
      kind: 'refuse',
      status: 404,
      message: `Aucune fiche du site n’a l’identifiant ${fiche().clientId}.`,
    })
    const prise = decideThirdPartyMatch(explicite, { ...aucun, explicit: fiche({ linkedTo: '977' }) })
    assert.equal(prise.kind, 'refuse')
    assert.match((prise as { message: string }).message, /977/)
  })

  it('rapproche la seule fiche libre au même SIRET, puis au même SIREN', () => {
    assert.deepEqual(decideThirdPartyMatch(lu(), { ...aucun, bySiret: [fiche()] }), {
      kind: 'update',
      clientId: fiche().clientId,
      how: 'siret',
    })
    assert.deepEqual(decideThirdPartyMatch(lu(), { ...aucun, bySiren: [fiche()] }), {
      kind: 'update',
      clientId: fiche().clientId,
      how: 'siren',
    })
  })

  it('ne devine pas : un SIRET déjà relié ailleurs, plusieurs fiches au même SIREN', () => {
    const doublon = decideThirdPartyMatch(lu(), { ...aucun, bySiret: [fiche({ linkedTo: '977' })] })
    assert.equal(doublon.kind, 'refuse')
    const deux = decideThirdPartyMatch(lu(), {
      ...aucun,
      bySiren: [fiche(), fiche({ clientId: '01999f00-0000-7000-8000-00000000c002', name: 'Atelier Martin Lyon' })],
    })
    assert.equal(deux.kind, 'refuse')
    assert.match((deux as { message: string }).message, /clientId/)
    // Les messages vont au journal : jamais de raison sociale.
    assert.doesNotMatch((deux as { message: string }).message, /Atelier/)
  })

  it('crée un client inconnu, jamais un prospect ni un tiers fermé', () => {
    assert.deepEqual(decideThirdPartyMatch(lu(), aucun), { kind: 'create' })
    assert.equal(decideThirdPartyMatch(lu({ statut: 'prospect' }), aucun).kind, 'ignore')
    assert.equal(decideThirdPartyMatch(lu({ statut: 'ferme' }), aucun).kind, 'ignore')
  })

  it('une suppression retire le lien, jamais la fiche', () => {
    const supprime: ReceivedThirdParty = { removed: true, crmId: '412', crmRef: null }
    assert.deepEqual(decideThirdPartyMatch(supprime, { ...aucun, linked: fiche() }), { kind: 'remove', clientId: fiche().clientId })
    assert.equal(decideThirdPartyMatch(supprime, aucun).kind, 'ignore')
  })

  it('ne réécrit une fiche que si un champ tenu par le CRM a changé', () => {
    const tiers = lu()
    if (tiers.removed) throw new Error('inattendu')
    assert.equal(clientFieldsChanged(tiers.fields, { ...tiers.fields }), false)
    assert.equal(clientFieldsChanged(tiers.fields, { ...tiers.fields, city: 'Villeurbanne' }), true)
  })
})

describe('tiers du CRM : contacts', () => {
  const recu = (crmId: string, overrides: Partial<{ fullName: string; isBilling: boolean }> = {}) => ({
    crmId,
    fullName: `Contact ${crmId}`,
    jobTitle: null,
    email: null,
    phone: null,
    isBilling: false,
    ...overrides,
  })
  const relie = (crmId: string, overrides: Partial<LinkedContact> = {}): LinkedContact => ({
    contactId: `site-${crmId}`,
    crmId,
    archived: false,
    anonymized: false,
    current: { fullName: `Contact ${crmId}`, jobTitle: null, email: null, phone: null, isBilling: false },
    ...overrides,
  })

  it('crée les nouveaux, met à jour les connus qui ont changé, retire les absents', () => {
    const plan = planContacts([recu('1'), recu('2', { isBilling: true }), recu('3')], [relie('2'), relie('3'), relie('4')])
    assert.deepEqual(plan.create.map((c) => c.crmId), ['1'])
    assert.deepEqual(plan.update.map((u) => u.contactId), ['site-2'])
    assert.deepEqual(plan.remove, ['site-4'])
  })

  it('remet sur la fiche un contact retiré qui revient, jamais un contact anonymisé', () => {
    const plan = planContacts([recu('2'), recu('5')], [relie('2', { archived: true }), relie('5', { archived: true, anonymized: true })])
    assert.deepEqual(plan.update, [{ contactId: 'site-2', contact: recu('2'), revive: true }])
    assert.deepEqual(plan.create, [])
    assert.deepEqual(plan.remove, [])
  })

  it('une liste vide retire tous les contacts reçus du CRM', () => {
    assert.deepEqual(planContacts([], [relie('2'), relie('3', { archived: true })]).remove, ['site-2'])
  })
})
