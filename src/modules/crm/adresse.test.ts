import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CrmCallError, guardedHttp, isPrivateAddress, parseCrmBaseUrl } from './adresse.ts'

/**
 * L'adresse du CRM saisie par la direction, et l'appel que le serveur y fait
 * (ADR 065) : https, adresse publique, aucune redirection suivie.
 */
describe('adresse du CRM', () => {
  it('normalise une adresse https : sans barre finale, chemin gardé', () => {
    assert.deepEqual(parseCrmBaseUrl(' https://crm.exemple.fr/ '), { ok: true, url: 'https://crm.exemple.fr' })
    assert.deepEqual(parseCrmBaseUrl('https://exemple.fr/dolibarr//'), { ok: true, url: 'https://exemple.fr/dolibarr' })
    assert.deepEqual(parseCrmBaseUrl('https://CRM.Exemple.fr:8443/erp'), { ok: true, url: 'https://crm.exemple.fr:8443/erp' })
  })

  it('refuse ce qui n’est pas une adresse https publique et nue', () => {
    for (const adresse of [
      '',
      'crm.exemple.fr',
      'http://crm.exemple.fr',
      'ftp://crm.exemple.fr',
      'https://admin:secret@crm.exemple.fr',
      'https://crm.exemple.fr/?DOLAPIKEY=x',
      'https://crm.exemple.fr/#a',
      'https://localhost',
      'https://intranet.local',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.20',
      'https://172.20.0.3',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://[fd00::1]',
      `https://exemple.fr/${'a'.repeat(500)}`,
    ]) {
      assert.equal(parseCrmBaseUrl(adresse).ok, false, adresse)
    }
  })

  it('reconnaît les adresses privées, IPv4 glissées dans une IPv6 comprises', () => {
    for (const adresse of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '224.0.0.1',
      '::',
      '::1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:0:a00:1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      'pas-une-ip',
    ]) {
      assert.equal(isPrivateAddress(adresse), true, adresse)
    }
    for (const adresse of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2a01:4f8::1', '::ffff:8.8.8.8', '2002:808:808::']) {
      assert.equal(isPrivateAddress(adresse), false, adresse)
    }
  })
})

describe('appel sortant sous garde', () => {
  const reponse = (status: number, corps = '') => new Response(corps, { status })

  it('refuse un nom qui mène à une adresse privée, sans appeler', async () => {
    let appels = 0
    const http = guardedHttp({
      resolve: async () => ['93.184.216.34', '10.0.0.7'],
      fetchImpl: (async () => {
        appels++
        return reponse(200)
      }) as typeof fetch,
    })
    await assert.rejects(http('https://crm.exemple.fr/api/index.php/status', {}), (error: unknown) => {
      assert.ok(error instanceof CrmCallError)
      assert.match(error.message, /adresse privée/)
      return true
    })
    assert.equal(appels, 0)
  })

  it('appelle une adresse publique sans suivre de redirection, en-têtes compris', async () => {
    const vus: { url: string; init: RequestInit }[] = []
    const http = guardedHttp({
      resolve: async () => ['93.184.216.34'],
      fetchImpl: (async (url: URL, init: RequestInit) => {
        vus.push({ url: String(url), init })
        return reponse(301)
      }) as unknown as typeof fetch,
    })
    const reponseRecue = await http('https://crm.exemple.fr/api/index.php/status', { DOLAPIKEY: 'cle' })
    assert.equal(reponseRecue.status, 301)
    assert.equal(vus[0]!.url, 'https://crm.exemple.fr/api/index.php/status')
    assert.equal(vus[0]!.init.redirect, 'manual')
    assert.deepEqual(vus[0]!.init.headers, { DOLAPIKEY: 'cle' })
  })

  it('dit pourquoi l’appel n’a pas abouti : nom inconnu, délai dépassé, connexion refusée', async () => {
    const inconnu = guardedHttp({
      resolve: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    await assert.rejects(inconnu('https://crm.exemple.fr', {}), /ne se résout pas/)

    const lent = guardedHttp({
      resolve: async () => ['93.184.216.34'],
      timeoutMs: 20,
      fetchImpl: ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as unknown as typeof fetch,
    })
    // Le minuteur d'`AbortSignal.timeout` ne retient pas le processus : celui-ci le fait.
    const garde = setTimeout(() => {}, 5000)
    await assert.rejects(lent('https://crm.exemple.fr', {}), /Pas de réponse du CRM/)
    clearTimeout(garde)

    const refuse = guardedHttp({
      resolve: async () => ['93.184.216.34'],
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await assert.rejects(refuse('https://crm.exemple.fr', {}), /CRM injoignable/)
  })

  it('ne lit qu’un extrait de la réponse', async () => {
    const http = guardedHttp({
      resolve: async () => ['93.184.216.34'],
      fetchImpl: (async () => reponse(200, 'x'.repeat(100_000))) as typeof fetch,
    })
    const texte = await (await http('https://crm.exemple.fr', {})).text()
    assert.equal(texte.length, 16 * 1024)
  })
})
