import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { currentTenantId } from '../../lib/tenant.ts'
import { serveCrmCall, type CrmCall } from './appels.ts'
import { crmTokenHash } from './jeton.ts'
import { passerelleDeTest } from './test-support.ts'

/**
 * La porte commune des routes d'un CRM (ADR 065) : 404 sans jeton valide,
 * flux coupé refusé, appel servi pour le centre du jeton, tout au journal de
 * ce centre.
 */
describe('porte des routes du CRM', () => {
  const UNIQUE = '01999f00-0000-7000-8000-000000000001'
  const AUTRE = '01999f00-0000-7000-8000-0000000000b2'
  const devis: CrmCall = { connector: 'dolibarr', flow: 'quotes', operation: 'GET /api/dolibarr/devis' }
  const requete = (jeton?: string) =>
    new Request('http://127.0.0.1:3100/api/dolibarr/devis', jeton ? { headers: { authorization: `Bearer ${jeton}` } } : {})
  const passerelle = () =>
    passerelleDeTest({
      serveur: 'jeton-du-serveur',
      reglages: [
        { tenantId: AUTRE, connector: 'dolibarr', tokenHash: crmTokenHash('crm_autre'), enabledFlows: ['quotes'] },
      ],
    })

  it('n’existe pas sans jeton valide : 404, rien de fait, rien au journal', async () => {
    const porte = passerelle()
    let fait = false
    for (const jeton of [undefined, 'faux']) {
      const { response, access } = await serveCrmCall(
        requete(jeton),
        devis,
        async () => {
          fait = true
          return { response: Response.json({}) }
        },
        porte,
      )
      assert.equal(response.status, 404)
      assert.equal(await response.text(), 'Introuvable.')
      assert.equal(access.result, 'unknown')
    }
    assert.equal(fait, false)
    assert.deepEqual(porte.journal, [])
  })

  it('sert l’appel pour le centre du jeton, et l’inscrit à son journal', async () => {
    const porte = passerelle()
    let centre: string | undefined
    const { response } = await serveCrmCall(
      requete('crm_autre'),
      devis,
      async () => {
        centre = currentTenantId()
        return { response: Response.json({ devis: [] }), summary: '0 devis au statut « ready ».' }
      },
      porte,
    )
    assert.equal(response.status, 200)
    assert.equal(centre, AUTRE)
    // Hors de l'appel, le centre courant redevient le centre unique.
    assert.equal(currentTenantId(), UNIQUE)
    assert.equal(porte.journal.length, 1)
    const { tenantId, entry } = porte.journal[0]!
    assert.equal(tenantId, AUTRE)
    assert.equal(entry.direction, 'inbound')
    assert.equal(entry.flow, 'quotes')
    assert.equal(entry.credential, 'screen')
    assert.equal(entry.statusCode, 200)
    assert.equal(entry.ok, true)
    assert.equal(entry.message, '0 devis au statut « ready ».')
  })

  it('sert l’ancien jeton pour le centre unique', async () => {
    const porte = passerelle()
    let centre: string | undefined
    await serveCrmCall(
      requete('jeton-du-serveur'),
      devis,
      async () => {
        centre = currentTenantId()
        return { response: Response.json({}) }
      },
      porte,
    )
    assert.equal(centre, UNIQUE)
    assert.equal(porte.journal[0]!.entry.credential, 'server')
  })

  it('refuse un flux coupé avec un message qui dit où le rouvrir, en 403 ou en 400', async () => {
    const porte = passerelle()
    const produits: CrmCall = { connector: 'dolibarr', flow: 'products', operation: 'POST /api/dolibarr/produits' }
    const { response } = await serveCrmCall(requete('crm_autre'), produits, async () => assert.fail('servi'), porte)
    assert.equal(response.status, 403)
    assert.match((await response.json()).erreur, /Flux « Produits et tarifs » désactivé.*Connexion au CRM/)
    assert.equal(porte.journal[0]!.entry.ok, false)
    assert.equal(porte.journal[0]!.entry.statusCode, 403)

    const webhook = await serveCrmCall(
      requete('crm_autre'),
      { ...produits, flowOffStatus: 400 },
      async () => assert.fail('servi'),
      porte,
    )
    assert.equal(webhook.response.status, 400)
  })

  it('inscrit au journal le message d’erreur rendu au CRM, sans consommer la réponse', async () => {
    const porte = passerelle()
    const { response } = await serveCrmCall(
      requete('crm_autre'),
      devis,
      async () => ({ response: Response.json({ erreur: 'La limite est un entier de 1 à 500.' }, { status: 400 }) }),
      porte,
    )
    assert.equal((await response.json()).erreur, 'La limite est un entier de 1 à 500.')
    assert.equal(porte.journal[0]!.entry.message, 'La limite est un entier de 1 à 500.')
    assert.equal(porte.journal[0]!.entry.ok, false)
  })

  it('inscrit une panne du site, puis la laisse remonter', async () => {
    const porte = passerelle()
    await assert.rejects(
      serveCrmCall(requete('crm_autre'), devis, async () => {
        throw new Error('base injoignable')
      }, porte),
      /base injoignable/,
    )
    assert.equal(porte.journal[0]!.entry.statusCode, 500)
    assert.equal(porte.journal[0]!.entry.message, 'Erreur du site.')
  })
})
