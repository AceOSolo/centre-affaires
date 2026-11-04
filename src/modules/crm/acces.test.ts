import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveCrmAccess, type CrmAccessStore, type CrmInboundSettings } from './acces.ts'
import type { CrmFlowId } from './flux.ts'
import { crmTokenHash } from './jeton.ts'

/**
 * Qui ouvre l'API du CRM, et pour quel centre (ADR 065) : le jeton de l'écran
 * désigne son centre ; celui du serveur vaut pour le centre unique tant
 * qu'aucun jeton n'y est réglé ; puis le flux doit être ouvert.
 */
describe('accès des routes du CRM', () => {
  const UNIQUE = '01999f00-0000-7000-8000-000000000001'
  const AUTRE = '01999f00-0000-7000-8000-0000000000b2'
  const SERVEUR = 'jeton-du-serveur+/='
  const devis = { connector: 'dolibarr', flow: 'quotes' } as const
  const produits = { connector: 'dolibarr', flow: 'products' } as const

  const magasin = (reglages: CrmInboundSettings[]): CrmAccessStore & { lectures: string[] } => {
    const lectures: string[] = []
    return {
      lectures,
      byTokenHash: async (hash) => {
        lectures.push('empreinte')
        return reglages.find((r) => r.tokenHash === hash)
      },
      forTenant: async (tenantId) => {
        lectures.push(`centre ${tenantId}`)
        return reglages.find((r) => r.tenantId === tenantId)
      },
    }
  }
  const reglage = (
    tenantId: string,
    jeton: string | null,
    flows: readonly CrmFlowId[] = ['quotes', 'products'],
  ): CrmInboundSettings => ({
    tenantId,
    connector: 'dolibarr',
    tokenHash: jeton ? crmTokenHash(jeton) : null,
    enabledFlows: [...flows],
  })
  const serveur = (token: string | undefined = SERVEUR) => ({ token, tenantId: UNIQUE })

  it('n’ouvre rien sans jeton, ni avec un jeton faux', async () => {
    assert.deepEqual(await resolveCrmAccess([], devis, magasin([]), serveur()), { result: 'unknown' })
    assert.deepEqual(await resolveCrmAccess(['faux'], devis, magasin([]), serveur()), { result: 'unknown' })
  })

  it('reste fermé quand le serveur n’a pas de jeton et qu’aucun n’est réglé', async () => {
    assert.deepEqual(await resolveCrmAccess([''], devis, magasin([]), serveur(undefined)), { result: 'unknown' })
    assert.deepEqual(await resolveCrmAccess(['x'], devis, magasin([]), serveur('')), { result: 'unknown' })
  })

  it('garde l’ancien jeton du serveur pour le centre unique tant que rien n’est réglé', async () => {
    assert.deepEqual(await resolveCrmAccess([SERVEUR], devis, magasin([]), serveur()), {
      result: 'ok',
      tenantId: UNIQUE,
      credential: 'server',
    })
    assert.deepEqual(await resolveCrmAccess([SERVEUR], produits, magasin([]), serveur()), {
      result: 'ok',
      tenantId: UNIQUE,
      credential: 'server',
    })
  })

  it('garde l’ancien jeton quand le centre a un réglage sans jeton d’écran, flux compris', async () => {
    const store = magasin([reglage(UNIQUE, null, ['products'])])
    assert.deepEqual(await resolveCrmAccess([SERVEUR], produits, store, serveur()), {
      result: 'ok',
      tenantId: UNIQUE,
      credential: 'server',
    })
    assert.deepEqual(await resolveCrmAccess([SERVEUR], devis, store, serveur()), {
      result: 'flow_off',
      tenantId: UNIQUE,
      credential: 'server',
    })
  })

  it('ouvre au nouveau jeton, et ferme l’ancien dès qu’un jeton est réglé à l’écran', async () => {
    const store = magasin([reglage(UNIQUE, 'crm_nouveau')])
    assert.deepEqual(await resolveCrmAccess(['crm_nouveau'], devis, store, serveur()), {
      result: 'ok',
      tenantId: UNIQUE,
      credential: 'screen',
    })
    assert.deepEqual(await resolveCrmAccess([SERVEUR], devis, store, serveur()), { result: 'unknown' })
  })

  it('sert le jeton d’un autre centre pour ce centre-là, jamais pour le centre unique', async () => {
    const store = magasin([reglage(UNIQUE, 'crm_unique'), reglage(AUTRE, 'crm_autre', ['quotes'])])
    assert.deepEqual(await resolveCrmAccess(['crm_autre'], devis, store, serveur()), {
      result: 'ok',
      tenantId: AUTRE,
      credential: 'screen',
    })
    // Ses flux sont les siens : le centre unique a les produits, lui non.
    assert.deepEqual(await resolveCrmAccess(['crm_autre'], produits, store, serveur()), {
      result: 'flow_off',
      tenantId: AUTRE,
      credential: 'screen',
    })
  })

  it('n’accepte pas le jeton du serveur pour un autre centre que le centre unique', async () => {
    // Le centre unique a réglé son jeton ; un autre centre sans jeton n'hérite pas de celui du serveur.
    const store = magasin([reglage(UNIQUE, 'crm_unique'), reglage(AUTRE, null)])
    assert.deepEqual(await resolveCrmAccess([SERVEUR], devis, store, serveur()), { result: 'unknown' })
  })

  it('refuse un jeton réglé pour un autre CRM', async () => {
    const store = magasin([{ ...reglage(UNIQUE, 'crm_autre_crm'), connector: 'autre' as never }])
    assert.deepEqual(await resolveCrmAccess(['crm_autre_crm'], devis, store, serveur()), { result: 'unknown' })
    // … et le jeton du serveur de Dolibarr non plus, quand le centre a choisi un autre CRM.
    const sansJeton = magasin([{ ...reglage(UNIQUE, null), connector: 'autre' as never }])
    assert.deepEqual(await resolveCrmAccess([SERVEUR], devis, sansJeton, serveur()), { result: 'unknown' })
  })

  it('essaie chaque jeton présenté : un en-tête faux n’empêche pas le bon jeton de l’adresse', async () => {
    assert.deepEqual(await resolveCrmAccess(['faux', SERVEUR], produits, magasin([]), serveur()), {
      result: 'ok',
      tenantId: UNIQUE,
      credential: 'server',
    })
  })

  it('ne lit le réglage du centre unique que pour un jeton égal à celui du serveur', async () => {
    const store = magasin([])
    await resolveCrmAccess(['faux'], devis, store, serveur())
    assert.deepEqual(store.lectures, ['empreinte'])
  })
})
