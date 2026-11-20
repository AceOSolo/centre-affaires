import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DolibarrClient } from '../crm/dolibarr-api.ts'
import {
  DEFAULT_EXTRAFIELD_SETTINGS,
  QUOTE_VALIDITY_DAYS,
  buildContactBody,
  buildProposalBody,
  buildProposalLines,
  buildThirdpartyBody,
  defaultExtrafields,
  joinExtrafieldSettings,
  parseQuoteExtrafields,
  readExtrafieldSettings,
  sendProposalToDolibarr,
  splitCompanyId,
  splitContactName,
  splitExtrafieldSettings,
  toDolibarrHtml,
} from './devis-dolibarr.ts'
import { toDolibarrProposal, type ProposalForDolibarr } from './propositions.ts'

/**
 * Le devis du site transformé en proposition Dolibarr (ADR 073), et
 * l'enchaînement des appels qui la créent.
 */

const site = { timeZone: 'Europe/Paris', city: 'Bourgoin-Jallieu', postalCode: '38300' }

function proposal(overrides: Partial<ProposalForDolibarr> = {}) {
  return toDolibarrProposal({
    id: '019aaaaa-0000-7000-8000-000000000001',
    number: 'DV-2026-0007',
    product: 'espace',
    channel: 'public',
    status: 'ready',
    // 23 h 30 UTC : déjà le lendemain à Paris (décision 4).
    createdAt: new Date('2026-10-27T23:30:00.000Z'),
    validatedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    currency: 'EUR',
    requesterName: 'Claire Martin',
    requesterEmail: 'claire@exemple.fr',
    requesterPhone: '0601020304',
    requesterCompany: 'Martin Conseil',
    answers: { participants: 8, usage: 'Atelier' },
    describedAnswers: null,
    message: 'Besoin d’un vidéoprojecteur',
    staffNote: null,
    client: null,
    booking: {
      id: 'b1',
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T12:00:00.000Z'),
      resourceName: 'Salle Mont-Blanc',
    },
    lines: [
      {
        position: 1,
        source: 'booking',
        label: 'Salle Mont-Blanc — jeudi 29 octobre 2026, 9 h 00 – 13 h 00',
        description: null,
        unit: 'half_day',
        quantity: 1,
        unitPriceCents: 9000,
        discountBp: null,
        discountAmountCents: null,
        vatRateBp: 2000,
        resourceId: 'r1',
        serviceId: null,
        ratePlanItemId: null,
        amountCents: 9000,
        productRefs: ['tarif.salle.sal-mb.demi-journee', 'tarif.salle.demi-journee'],
      },
    ],
    ...overrides,
  })
}

describe('devis du site → proposition Dolibarr', () => {
  it('pose les dates au jour de la demande, au fuseau du centre, et la fin de validité à 90 jours', () => {
    const body = buildProposalBody(proposal(), { socid: '1173', contactId: '55953', productIds: new Map(), site, extrafields: {} })
    // 23 h 30 UTC le 27/10 : le 28/10 à Paris.
    for (const field of ['datec', 'date', 'date_creation', 'datev', 'date_validation']) {
      assert.equal(body[field], '2026-10-28', field)
    }
    assert.equal(QUOTE_VALIDITY_DAYS, 90)
    assert.equal(body.fin_validite, '2027-01-26')
    assert.equal(body.socid, '1173')
    assert.equal(body.contactid, '55953')
    assert.equal(body.ref_client, 'DV-2026-0007')
  })

  it('remplit seul ce que le site sait : dates de la demande, lieu, période, participants, détail', () => {
    const fields = defaultExtrafields(proposal(), site)
    assert.equal(fields.options_date_dde, '2026-10-28')
    assert.equal(fields.options_date_dde_client, '2026-10-28')
    assert.equal(fields.options_datretsouh, '2026-10-28')
    assert.equal(fields.options_ville, 'Bourgoin-Jallieu')
    assert.equal(fields.options_code_postal_lieu_intervention, '38300')
    assert.equal(fields.options_dateapartir, '2026-10-29')
    assert.equal(fields.options_dateavant, '2026-10-29')
    assert.equal(fields.options_nb_participant, 8)
    const detail = String(fields.options_preciplanning)
    assert.match(detail, /^Message du demandeur : Besoin d’un vidéoprojecteur/)
    assert.match(detail, /Nombre de participants : 8/)
    assert.match(detail, /Réservation : Salle Mont-Blanc, du 29\/10\/2026 au 29\/10\/2026/)
    assert.match(detail, /Demande du site : DV-2026-0007$/)
    // Les codes propres au Dolibarr du centre ne sont jamais devinés.
    for (const field of ['options_typage_devis', 'options_quiindiquelestatut', 'options_mode', 'options_origine_dde']) {
      assert.equal(field in fields, false, field)
    }
  })

  it('une domiciliation, sans réservation, prend sa date de début', () => {
    const fields = defaultExtrafields(
      proposal({ booking: null, product: 'domiciliation', answers: { debut: '2026-11-15' } }),
      site,
    )
    assert.equal(fields.options_dateapartir, '2026-11-15')
    assert.equal(fields.options_dateavant, '2026-11-15')
    assert.match(String(fields.options_preciplanning), /À partir du : 15\/11\/2026/)
  })

  it('les champs réglés par la direction l’emportent sur ceux du site', () => {
    const body = buildProposalBody(proposal(), {
      socid: '1',
      contactId: null,
      productIds: new Map(),
      site,
      extrafields: { options_typage_devis: 1, options_ville: 'Lyon' },
    })
    const options = body.array_options as Record<string, unknown>
    assert.equal(options.options_typage_devis, 1)
    assert.equal(options.options_ville, 'Lyon')
    assert.equal(options.options_nb_participant, 8)
    assert.equal('contactid' in body, false)
  })

  it('une ligne qui vise un produit Dolibarr garde le prix annoncé ; sans produit, la désignation est la description', () => {
    const lines = buildProposalLines(proposal(), new Map([[1, '14221']]))
    assert.deepEqual(lines[0], {
      product_type: '1',
      qty: 1,
      subprice: '90.00',
      tva_tx: '20.000',
      fk_product: '14221',
      label: 'Salle Mont-Blanc — jeudi 29 octobre 2026, 9 h 00 – 13 h 00',
    })
    const free = buildProposalLines(proposal(), new Map())
    assert.equal(free[0]!.fk_product, undefined)
    assert.match(String(free[0]!.desc), /^Salle Mont-Blanc/)
  })

  it('la remise en pourcentage suit la ligne ; la remise en montant devient une ligne négative', () => {
    const base = {
      position: 1,
      source: 'service' as const,
      label: 'Café d’accueil',
      description: 'Pour 8 <personnes> & plus',
      unit: 'unit' as const,
      quantity: 8,
      unitPriceCents: 250,
      vatRateBp: 550,
      resourceId: null,
      serviceId: 's1',
      ratePlanItemId: null,
      amountCents: 1800,
    }
    const percent = buildProposalLines(proposal({ lines: [{ ...base, discountBp: 1000, discountAmountCents: null }] }), new Map())
    assert.equal(percent[0]!.remise_percent, '10')
    assert.equal(percent[0]!.tva_tx, '5.500')
    assert.equal(percent[0]!.desc, 'Café d’accueil<br />\r\nPour 8 &lt;personnes&gt; &amp; plus')

    const amount = buildProposalLines(proposal({ lines: [{ ...base, discountBp: null, discountAmountCents: 50 }] }), new Map())
    assert.equal(amount.length, 2)
    assert.equal(amount[1]!.subprice, '-0.50')
    assert.equal(amount[1]!.qty, 8)
    assert.equal(amount[1]!.tva_tx, '5.500')
  })

  it('met le texte du site en HTML simple, sans balise injectée', () => {
    assert.equal(toDolibarrHtml('a <b>\nb'), 'a &lt;b&gt;<br />\r\nb')
  })

  it('range SIRET et SIREN comme Dolibarr : idprof2 et idprof1', () => {
    assert.deepEqual(splitCompanyId('123 456 789 00012'), { siret: '12345678900012', siren: '123456789' })
    assert.deepEqual(splitCompanyId('123456789'), { siret: null, siren: '123456789' })
    assert.deepEqual(splitCompanyId('abc'), { siret: null, siren: null })
    assert.deepEqual(splitCompanyId(null), { siret: null, siren: null })
  })

  it('un tiers inconnu naît prospect, avec ce que le demandeur a donné', () => {
    const body = buildThirdpartyBody(proposal({ answers: { siren: '123456789' } }))
    assert.equal(body.name, 'Martin Conseil')
    assert.equal(body.client, '2')
    assert.equal(body.email, 'claire@exemple.fr')
    assert.equal(body.idprof1, '123456789')
    assert.equal('idprof2' in body, false)
    assert.equal('address' in body, false)
  })

  it('un client connu garde son adresse et sa TVA', () => {
    const body = buildThirdpartyBody(
      proposal({
        client: {
          id: 'c1',
          name: 'Martin SAS',
          siret: '12345678900012',
          vatNumber: 'FR12345678900',
          email: 'compta@martin.fr',
          phone: null,
          addressLine1: '3 rue des Lilas',
          addressLine2: 'Bât. B',
          postalCode: '38300',
          city: 'Bourgoin-Jallieu',
          country: 'FR',
        },
      }),
    )
    assert.equal(body.address, '3 rue des Lilas\nBât. B')
    assert.equal(body.zip, '38300')
    assert.equal(body.country_code, 'FR')
    assert.equal(body.idprof2, '12345678900012')
    assert.equal(body.tva_intra, 'FR12345678900')
  })

  it('découpe le nom du contact, ou prend l’adresse à défaut de nom', () => {
    assert.deepEqual(splitContactName('Claire Martin'), { firstname: 'Claire', lastname: 'Martin' })
    assert.deepEqual(splitContactName('Jean de La Tour'), { firstname: 'Jean', lastname: 'de La Tour' })
    assert.deepEqual(splitContactName('Madonna'), { firstname: '', lastname: 'Madonna' })
    assert.deepEqual(buildContactBody(proposal(), '9'), {
      socid: '9',
      lastname: 'Martin',
      firstname: 'Claire',
      email: 'claire@exemple.fr',
      phone_pro: '0601020304',
      statut: '1',
    })
    assert.equal(buildContactBody(proposal({ requesterName: null, requesterEmail: null }), '9'), undefined)
    assert.equal(buildContactBody(proposal({ requesterName: null }), '9')?.lastname, 'claire@exemple.fr')
  })
})

describe('champs complémentaires réglés par la direction', () => {
  it('lit un objet de champs options_*', () => {
    assert.deepEqual(parseQuoteExtrafields(''), { ok: true, value: {} })
    assert.deepEqual(parseQuoteExtrafields('{ "options_typage_devis": 1, "options_origine_dde": "centre", "options_x": null, "options_y": true }'), {
      ok: true,
      value: { options_typage_devis: 1, options_origine_dde: 'centre', options_x: null, options_y: true },
    })
  })

  it('assemble les trois réglages pour l’enregistrement et les relit sans les défauts', () => {
    const stored = joinExtrafieldSettings({
      proposal: { options_mode: 3 },
      contact: { options_origine_contact: 60 },
      thirdparty: { options_potential: '4' },
    })
    assert.deepEqual(stored, { options_mode: 3, contact: { options_origine_contact: 60 }, tiers: { options_potential: '4' } })
    assert.deepEqual(readExtrafieldSettings(stored), {
      proposal: { options_mode: 3 },
      contact: { options_origine_contact: 60 },
      thirdparty: { options_potential: '4' },
    })
    assert.deepEqual(joinExtrafieldSettings({ proposal: {}, contact: {}, thirdparty: {} }), {})
  })

  it('un objet sans réglage reçoit les valeurs par défaut du centre, un objet réglé les remplace entièrement', () => {
    assert.deepEqual(splitExtrafieldSettings({}), DEFAULT_EXTRAFIELD_SETTINGS)
    assert.deepEqual(splitExtrafieldSettings({ options_mode: 1 }), {
      proposal: { options_mode: 1 },
      contact: DEFAULT_EXTRAFIELD_SETTINGS.contact,
      thirdparty: DEFAULT_EXTRAFIELD_SETTINGS.thirdparty,
    })
    assert.deepEqual(splitExtrafieldSettings({ contact: { options_origine_contact: 12 } }).contact, { options_origine_contact: 12 })
  })

  it('les champs réglés pour un contact et un tiers partent dans array_options de leur création', () => {
    assert.deepEqual(buildContactBody(proposal(), '9', { options_origine_contact: 60 })?.array_options, { options_origine_contact: 60 })
    assert.equal('array_options' in (buildContactBody(proposal(), '9') ?? {}), false)
    assert.deepEqual(buildThirdpartyBody(proposal(), { options_potential: '4' }).array_options, { options_potential: '4' })
    assert.equal('array_options' in buildThirdpartyBody(proposal()), false)
  })

  it('refuse ce qui n’est pas un champ complémentaire', () => {
    for (const texte of ['pas du json', '[1]', '"a"', '{ "socid": 5 }', '{ "options_a": { "b": 1 } }', '{ "options_A": 1 }', '{ "options_a": [1] }']) {
      assert.equal(parseQuoteExtrafields(texte).ok, false, texte)
    }
  })
})

/** Un client Dolibarr qui note ses appels et répond ce qu'on lui prépare. */
function fakeClient(setup: Partial<DolibarrClient> = {}) {
  const calls: string[] = []
  const log =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push(`${name}${args.length ? ` ${JSON.stringify(args[0] ?? '').slice(0, 60)}` : ''}`)
      return value
    }
  const client: DolibarrClient = {
    findProposalByClientRef: log('findProposal', undefined),
    findThirdparty: log('findThirdparty', undefined),
    createThirdparty: log('createThirdparty', '1173'),
    findContact: log('findContact', undefined),
    createContact: log('createContact', '55953'),
    findProductId: log('findProduct', undefined),
    createProposal: log('createProposal', '412'),
    linkProposalContact: log('link', undefined),
    proposalRef: log('proposalRef', '(PROV412)'),
    ...setup,
  } as DolibarrClient
  return { client, calls }
}

describe('envoi d’un devis à Dolibarr', () => {
  const options = { site, extrafields: {} }

  it('crée le tiers, le contact, retrouve le produit, crée la proposition et rattache le contact', async () => {
    const { client, calls } = fakeClient({
      findProductId: async (ref) => (ref === 'tarif.salle.demi-journee' ? '14221' : undefined),
      createProposal: async (body) => {
        calls.push('createProposal')
        const lines = body.lines as { fk_product?: string }[]
        assert.equal(body.socid, '1173')
        assert.equal(body.contactid, '55953')
        // Le prix propre à la salle n'existe pas : on retombe sur celui du type.
        assert.equal(lines[0]!.fk_product, '14221')
        return '412'
      },
    })
    const sent = await sendProposalToDolibarr(client, proposal(), options)
    assert.deepEqual(sent, { dolibarrId: '412', dolibarrRef: '(PROV412)', reused: false, warning: null })
    assert.deepEqual(
      calls.map((call) => call.split(' ')[0]),
      ['findProposal', 'findThirdparty', 'createThirdparty', 'findContact', 'createContact', 'createProposal', 'link', 'proposalRef'],
    )
  })

  it('ne recrée rien quand la proposition existe déjà (envoi interrompu puis rejoué)', async () => {
    const { client, calls } = fakeClient({ findProposalByClientRef: async () => ({ id: '77', ref: 'PR2611-0003' }) })
    const sent = await sendProposalToDolibarr(client, proposal(), options)
    assert.deepEqual(sent, { dolibarrId: '77', dolibarrRef: 'PR2611-0003', reused: true, warning: null })
    assert.deepEqual(calls, [])
  })

  it('reprend le tiers déjà trouvé, ou lié par le CRM, sans en créer un autre', async () => {
    const found = fakeClient({ findThirdparty: async () => '900', findContact: async () => '901' })
    await sendProposalToDolibarr(found.client, proposal(), options)
    assert.equal(found.calls.some((call) => call.startsWith('createThirdparty') || call.startsWith('createContact')), false)

    const linked = fakeClient()
    await sendProposalToDolibarr(linked.client, proposal(), { ...options, linkedThirdpartyId: '55' })
    assert.equal(linked.calls.some((call) => call.startsWith('findThirdparty') || call.startsWith('createThirdparty')), false)
  })

  it('cherche chaque produit une fois, même porté par plusieurs lignes', async () => {
    const lines = [1, 2].map((position) => ({
      position,
      source: 'booking' as const,
      label: `Ligne ${position}`,
      description: null,
      unit: 'hour' as const,
      quantity: 1,
      unitPriceCents: 1000,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 2000,
      resourceId: 'r1',
      serviceId: null,
      ratePlanItemId: null,
      amountCents: 1000,
      productRefs: ['tarif.salle.heure'],
    }))
    const { client, calls } = fakeClient({ findProductId: async (ref) => (calls.push(`findProduct ${ref}`), '14221') })
    await sendProposalToDolibarr(client, proposal({ lines }), options)
    assert.equal(calls.filter((call) => call.startsWith('findProduct')).length, 1)
  })

  it('un contact non rattaché n’empêche pas la proposition : l’échec est signalé', async () => {
    const { client } = fakeClient({
      linkProposalContact: async () => {
        throw new Error('Rattachement du contact : réponse 500 de Dolibarr.')
      },
    })
    const sent = await sendProposalToDolibarr(client, proposal(), options)
    assert.equal(sent.dolibarrId, '412')
    assert.match(sent.warning ?? '', /Contact non rattaché : Rattachement du contact/)
  })

  it('un échec de création laisse l’erreur remonter : le devis restera « prêt »', async () => {
    const { client } = fakeClient({
      createProposal: async () => {
        throw new Error('Création de la proposition : réponse 400 de Dolibarr.')
      },
    })
    await assert.rejects(sendProposalToDolibarr(client, proposal(), options), /réponse 400/)
  })

  it('sans nom ni adresse de demandeur, pas de contact', async () => {
    const { client, calls } = fakeClient()
    await sendProposalToDolibarr(client, proposal({ requesterName: null, requesterEmail: null }), options)
    assert.equal(calls.some((call) => call.includes('Contact') || call.startsWith('link')), false)
  })
})
