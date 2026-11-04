import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ResourceType } from '../ressources/schema.ts'
import {
  consumptionDraft,
  consumptionWindow,
  isReady,
  plannedCancellations,
  sourceFingerprint,
  sourceKey,
  sourceValidity,
  toDolibarrConsumption,
  type BookingSource,
  type ConsumptionForCrm,
  type ConsumptionSource,
  type MailOpeningSource,
  type MailPagesSource,
  type MailRequestSource,
} from './consommations.ts'

/**
 * Ce qui est une consommation facturable, quand elle est prête, quand elle
 * s'annule, et ce que le CRM en lit (ADR 066). Règles pures : la base est
 * éprouvée par `consommations.db.test.ts`.
 */

const PARIS = 'Europe/Paris'
const CLIENT = '01999f00-0000-7000-8000-00000000c001'

const reservation = (overrides: Partial<BookingSource> = {}): BookingSource => ({
  nature: 'booking',
  sourceId: '01999f00-0000-7000-8000-00000000b001',
  clientId: CLIENT,
  kind: 'booking',
  status: 'confirmed',
  startsAt: new Date('2026-10-14T07:00:00Z'),
  endsAt: new Date('2026-10-14T11:00:00Z'),
  resourceId: '01999f00-0000-7000-8000-00000000a001',
  resourceName: 'Salle Mont Blanc',
  resourceCode: 'SAL-MB',
  resourceType: 'salle',
  contractId: null,
  contractReference: null,
  coveredByProposal: false,
  quote: {
    unit: 'half_day',
    quantity: 1,
    unitPriceCents: 9000,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    currency: 'EUR',
    amountCents: 9000,
  },
  ...overrides,
})

const pli = {
  clientId: CLIENT,
  mailItemId: '01999f00-0000-7000-8000-00000000d001',
  mailKind: 'lettre' as const,
  receivedAt: new Date('2026-10-12T08:30:00Z'),
  removed: false,
}

const ouverture = (overrides: Partial<MailOpeningSource> = {}): MailOpeningSource => ({
  ...pli,
  nature: 'mail_opening',
  sourceId: pli.mailItemId,
  openedAt: new Date('2026-10-13T09:00:00Z'),
  ...overrides,
})

const pages = (overrides: Partial<MailPagesSource> = {}): MailPagesSource => ({
  ...pli,
  nature: 'mail_pages',
  sourceId: '01999f00-0000-7000-8000-00000000e001',
  openedAt: new Date('2026-10-13T09:00:00Z'),
  pageCount: 7,
  ...overrides,
})

const demande = (overrides: Partial<MailRequestSource> = {}): MailRequestSource => ({
  ...pli,
  nature: 'mail_forward',
  sourceId: '01999f00-0000-7000-8000-00000000f001',
  status: 'done',
  completedAt: new Date('2026-10-20T15:00:00Z'),
  postageCents: 450,
  postageCurrency: 'EUR',
  ...overrides,
})

// Le 4 novembre 2026 : octobre est clos, novembre ne l'est pas.
const fenetre = consumptionWindow({ from: '2026-10-01', now: new Date('2026-11-04T10:00:00Z'), timeZone: PARIS, includedPages: 5 })

describe('consommations : les bornes d’un passage', () => {
  it('se comptent dans le calendrier du centre, heure d’hiver comprise', () => {
    // 1er octobre à minuit à Paris (heure d'été) ; 1er novembre à minuit (heure d'hiver).
    assert.equal(fenetre.startAt?.toISOString(), '2026-09-30T22:00:00.000Z')
    assert.equal(fenetre.mailCutoff.toISOString(), '2026-10-31T23:00:00.000Z')
    // Transmises revues depuis le 1er août.
    assert.equal(fenetre.reviewSentFrom.toISOString(), '2026-07-31T22:00:00.000Z')
  })

  it('ne prend rien sans date de départ', () => {
    const sansDepart = consumptionWindow({ from: null, now: new Date('2026-11-04T10:00:00Z'), timeZone: PARIS, includedPages: 0 })
    assert.equal(sansDepart.startAt, null)
    assert.equal(isReady(reservation(), sansDepart), false)
    assert.equal(isReady(ouverture(), sansDepart), false)
  })
})

describe('consommations : ce qui en est une', () => {
  it('une réservation confirmée, d’un client, sans devis vivant', () => {
    assert.deepEqual(sourceValidity(reservation()), { valid: true })
    assert.equal(sourceValidity(reservation({ status: 'cancelled' })).valid, false)
    assert.equal(sourceValidity(reservation({ status: 'pending' })).valid, false)
    assert.equal(sourceValidity(reservation({ clientId: null })).valid, false)
    assert.equal(sourceValidity(reservation({ kind: 'unavailability' })).valid, false)
  })

  it('jamais une réservation passée par un devis : Dolibarr la facture à partir du devis', () => {
    const validity = sourceValidity(reservation({ coveredByProposal: true }))
    assert.equal(validity.valid, false)
    assert.match((validity as { reason: string }).reason, /devis/)
  })

  it('une réservation de toute ressource, sans liste de types : le matériel s’y range seul', () => {
    const materiel = reservation({ resourceType: 'materiel' as ResourceType, resourceName: 'Vidéoprojecteur', quote: { ...reservation().quote!, unit: 'day' } })
    assert.equal(isReady(materiel, fenetre), true)
    const draft = consumptionDraft(materiel, { timeZone: PARIS, includedPages: 0 })
    assert.equal(draft.productRef, 'tarif.materiel.journee')
    assert.equal(draft.details.typeRessource, 'materiel')
  })

  it('un pli ouvert, qui n’a pas été retiré', () => {
    assert.deepEqual(sourceValidity(ouverture()), { valid: true })
    assert.equal(sourceValidity(ouverture({ removed: true })).valid, false)
    assert.equal(sourceValidity(ouverture({ openedAt: null })).valid, false)
  })

  it('une numérisation ou une réexpédition faite', () => {
    assert.deepEqual(sourceValidity(demande()), { valid: true })
    assert.equal(sourceValidity(demande({ status: 'in_progress', completedAt: null })).valid, false)
    assert.equal(sourceValidity(demande({ removed: true })).valid, false)
  })

  it('une source introuvable n’en est plus une', () => {
    assert.equal(sourceValidity(undefined).valid, false)
  })
})

describe('consommations : quand elles sont prêtes', () => {
  it('une réservation, une fois terminée', () => {
    assert.equal(isReady(reservation(), fenetre), true)
    const enCours = reservation({ startsAt: new Date('2026-11-04T08:00:00Z'), endsAt: new Date('2026-11-04T12:00:00Z') })
    assert.equal(isReady(enCours, fenetre), false)
  })

  it('rien d’antérieur à la date de départ : ce qui a été facturé à la main ne repart pas', () => {
    assert.equal(isReady(reservation({ startsAt: new Date('2026-09-30T08:00:00Z'), endsAt: new Date('2026-09-30T10:00:00Z') }), fenetre), false)
    // Le 1er octobre à 0 h 30 à Paris est le 30 septembre en UTC, et pourtant d'octobre.
    assert.equal(isReady(ouverture({ openedAt: new Date('2026-09-30T22:30:00Z') }), fenetre), true)
    assert.equal(isReady(ouverture({ openedAt: new Date('2026-09-30T21:30:00Z') }), fenetre), false)
  })

  it('le courrier, une fois son mois clos : ses pages se corrigent jusque-là', () => {
    assert.equal(isReady(ouverture(), fenetre), true)
    assert.equal(isReady(ouverture({ openedAt: new Date('2026-11-02T09:00:00Z') }), fenetre), false)
    // Le 31 octobre à 23 h 30 à Paris : encore octobre.
    assert.equal(isReady(ouverture({ openedAt: new Date('2026-10-31T22:30:00Z') }), fenetre), true)
    assert.equal(isReady(demande({ nature: 'mail_scan', completedAt: new Date('2026-11-03T09:00:00Z') }), fenetre), false)
  })

  it('des pages, seulement au-delà de celles comprises dans l’ouverture', () => {
    assert.equal(isReady(pages({ pageCount: 5 }), fenetre), false)
    assert.equal(isReady(pages({ pageCount: 6 }), fenetre), true)
    assert.equal(isReady(pages({ pageCount: null }), fenetre), false)
  })

  it('une réexpédition, une fois ses frais relevés — zéro compris', () => {
    assert.equal(isReady(demande({ postageCents: null }), fenetre), false)
    assert.equal(isReady(demande({ postageCents: 0 }), fenetre), true)
  })
})

describe('consommations : annulations', () => {
  const vivante = (source: ConsumptionSource, fingerprint = sourceFingerprint(source)) => ({
    id: `c-${source.sourceId}`,
    nature: source.nature,
    sourceId: source.sourceId,
    fingerprint,
  })
  const sources = (...list: ConsumptionSource[]) => new Map(list.map((s) => [sourceKey(s.nature, s.sourceId), s]))

  it('rien ne bouge tant que la source ne change pas', () => {
    assert.deepEqual(plannedCancellations([vivante(reservation()), vivante(ouverture())], sources(reservation(), ouverture())), [])
  })

  it('une source annulée, retirée ou introuvable annule sa consommation, et dit pourquoi', () => {
    const plan = plannedCancellations(
      [vivante(reservation()), vivante(ouverture()), vivante(demande())],
      sources(reservation({ status: 'cancelled' }), ouverture({ removed: true })),
    )
    assert.deepEqual(plan, [
      { id: `c-${reservation().sourceId}`, reason: 'Réservation annulée.' },
      { id: `c-${ouverture().sourceId}`, reason: 'Pli retiré (enregistré par erreur).' },
      { id: `c-${demande().sourceId}`, reason: 'Source introuvable sur le site.' },
    ])
  })

  it('une source modifiée annule l’instantané, qu’une nouvelle consommation remplace', () => {
    const avant = reservation()
    const deplacee = reservation({ endsAt: new Date('2026-10-14T13:00:00Z') })
    const [annulation] = plannedCancellations([vivante(avant)], sources(deplacee))
    assert.match(annulation!.reason, /remplacée par une nouvelle consommation/)
    // Frais corrigés, pages recomptées, client changé : même règle.
    assert.equal(plannedCancellations([vivante(demande())], sources(demande({ postageCents: 520 }))).length, 1)
    assert.equal(plannedCancellations([vivante(pages())], sources(pages({ pageCount: 9 }))).length, 1)
    assert.equal(plannedCancellations([vivante(ouverture())], sources(ouverture({ clientId: 'autre' }))).length, 1)
  })

  it('le réglage des pages comprises n’entre pas dans l’empreinte : le changer ne refait rien', () => {
    assert.equal(sourceFingerprint(pages()), sourceFingerprint(pages()))
    const draftA = consumptionDraft(pages(), { timeZone: PARIS, includedPages: 5 })
    const draftB = consumptionDraft(pages(), { timeZone: PARIS, includedPages: 2 })
    assert.equal(draftA.fingerprint, draftB.fingerprint)
    assert.notEqual(draftA.quantity, draftB.quantity)
  })
})

describe('consommations : l’instantané', () => {
  const contexte = { timeZone: PARIS, includedPages: 5 }

  it('une réservation porte son devis figé, tel qu’annoncé au client', () => {
    const draft = consumptionDraft(reservation(), contexte)
    assert.equal(draft.nature, 'booking')
    assert.equal(draft.clientId, CLIENT)
    assert.equal(draft.quantity, 1)
    assert.equal(draft.unit, 'half_day')
    assert.equal(draft.productRef, 'tarif.salle.demi-journee')
    assert.equal(draft.unitPriceCents, 9000)
    assert.equal(draft.amountCents, 9000)
    assert.equal(draft.vatRateBp, 2000)
    assert.equal(draft.currency, 'EUR')
    assert.match(draft.description, /^Salle Mont Blanc — mercredi 14 octobre 2026, 09:00 – 13:00$/)
    assert.equal(draft.occurredAt.toISOString(), '2026-10-14T07:00:00.000Z')
  })

  it('une réservation sans devis figé part sans prix : le CRM la chiffrera', () => {
    const draft = consumptionDraft(reservation({ quote: null }), contexte)
    assert.equal(draft.quantity, 1)
    assert.equal(draft.unit, null)
    assert.equal(draft.productRef, null)
    assert.equal(draft.unitPriceCents, null)
    assert.equal(draft.amountCents, null)
  })

  it('les actes du courrier partent sans prix, sous la référence de leur service', () => {
    const acte = consumptionDraft(ouverture(), contexte)
    assert.equal(acte.productRef, 'courrier.ouverture')
    assert.equal(acte.quantity, 1)
    assert.equal(acte.unitPriceCents, null)
    assert.equal(acte.description, 'Ouverture et numérisation d’un pli (lettre, reçu le 12/10/2026)')

    const page = consumptionDraft(pages(), contexte)
    assert.equal(page.productRef, 'courrier.page')
    assert.equal(page.quantity, 2)
    assert.equal(page.description, '2 pages numérisées au-delà des 5 comprises à l’ouverture d’un pli (lettre, reçu le 12/10/2026)')
    assert.equal(consumptionDraft(pages({ pageCount: 6 }), contexte).description.startsWith('1 page numérisée au-delà'), true)

    assert.equal(consumptionDraft(demande({ nature: 'mail_scan' }), contexte).productRef, 'courrier.numerisation')
    const reexpedition = consumptionDraft(demande(), contexte)
    assert.equal(reexpedition.productRef, 'courrier.reexpedition')
    assert.equal(reexpedition.feesCents, 450)
    assert.equal(reexpedition.currency, 'EUR')
  })
})

describe('consommations : ce que le CRM lit', () => {
  const ligne = (overrides: Partial<ConsumptionForCrm> = {}): ConsumptionForCrm => {
    const draft = consumptionDraft(reservation({ contractId: 'k1', contractReference: 'CT-2026-0003' }), { timeZone: PARIS, includedPages: 0 })
    return {
      ...draft,
      id: '01999f00-0000-7000-8000-0000000c0c01',
      status: 'ready',
      crmId: null,
      crmRef: null,
      createdAt: new Date('2026-11-04T10:00:00Z'),
      sentAt: null,
      cancelledAt: null,
      cancellationReason: null,
      client: { id: CLIENT, name: 'Atelier Martin', siret: '12345678900012', crmId: '412' },
      contractCrmId: '57',
      ...overrides,
    }
  }

  it('une réservation : prix en centimes et en décimal, ressource, rayon du site, contrat', () => {
    const json = toDolibarrConsumption(ligne(), PARIS)
    assert.equal(json.nature, 'reservation')
    assert.equal(json.statut, 'ready')
    assert.equal(json.jour, '2026-10-14')
    assert.deepEqual(json.tiers, { clientId: CLIENT, dolibarrId: '412', nom: 'Atelier Martin', siret: '12345678900012' })
    assert.equal(json.produit, 'tarif.salle.demi-journee')
    assert.equal(json.unite, 'demi-journée')
    assert.deepEqual(json.prix, {
      prixUnitaireHtCentimes: 9000,
      prixUnitaireHt: '90.00',
      remisePourcent: null,
      remiseMontantCentimes: null,
      tauxTva: '20',
      montantHtCentimes: 9000,
      devise: 'EUR',
    })
    assert.equal(json.frais, null)
    assert.equal(json.reservation?.produitSite, 'salles')
    assert.equal(json.reservation?.ressourceCode, 'SAL-MB')
    assert.deepEqual(json.contrat, { id: 'k1', reference: 'CT-2026-0003', dolibarrId: '57' })
    assert.equal(json.courrier, null)
  })

  it('un type de ressource qu’aucun rayon ne range encore n’a pas de rayon, mais part quand même', () => {
    const draft = consumptionDraft(reservation({ resourceType: 'inconnu' as ResourceType }), { timeZone: PARIS, includedPages: 0 })
    const json = toDolibarrConsumption({ ...ligne(), details: draft.details }, PARIS)
    assert.equal(json.reservation?.typeRessource, 'inconnu')
    assert.equal(json.reservation?.produitSite, null)
  })

  it('une réexpédition : ses frais à part, au centime ; des frais nuls n’en font pas', () => {
    const draft = consumptionDraft(demande(), { timeZone: PARIS, includedPages: 0 })
    const json = toDolibarrConsumption({ ...ligne(), ...draft, contractCrmId: null }, PARIS)
    assert.equal(json.nature, 'reexpedition')
    assert.equal(json.prix, null)
    assert.deepEqual(json.frais, { libelle: 'Frais d’affranchissement', montantCentimes: 450, montant: '4.50', devise: 'EUR' })
    assert.deepEqual(json.courrier, {
      pliId: pli.mailItemId,
      typePli: 'lettre',
      recuLe: '2026-10-12T08:30:00.000Z',
      demandeId: demande().sourceId,
    })
    assert.equal(json.reservation, null)
    assert.equal(json.contrat, null)
    const sansFrais = consumptionDraft(demande({ postageCents: 0 }), { timeZone: PARIS, includedPages: 0 })
    assert.equal(toDolibarrConsumption({ ...ligne(), ...sansFrais }, PARIS).frais, null)
  })

  it('une annulation après reprise garde la référence du CRM et dit pourquoi', () => {
    const json = toDolibarrConsumption(
      ligne({
        status: 'cancelled',
        crmId: '1834',
        crmRef: 'FA2611-0042',
        sentAt: new Date('2026-11-04T11:00:00Z'),
        cancelledAt: new Date('2026-11-05T08:00:00Z'),
        cancellationReason: 'Réservation annulée.',
      }),
      PARIS,
    )
    assert.equal(json.statut, 'cancelled')
    assert.equal(json.dolibarrId, '1834')
    assert.equal(json.transmisLe, '2026-11-04T11:00:00.000Z')
    assert.equal(json.annuleLe, '2026-11-05T08:00:00.000Z')
    assert.equal(json.motifAnnulation, 'Réservation annulée.')
  })
})
