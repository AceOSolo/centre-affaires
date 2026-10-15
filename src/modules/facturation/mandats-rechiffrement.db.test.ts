import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { insertReturning } from '../../db/returning.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { DocumentKeyring } from '../../lib/chiffrement-documents.ts'
import { toutVider } from '../clients/test-support.ts'
import { openIban, sealIban } from './iban.ts'
import { rekeyMandateIbans } from './mandats-rechiffrement.ts'
import { sepaMandates } from './schema-factures.ts'

/**
 * Rechiffrement des IBAN des mandats après une rotation de clé (R16, ADR 020,
 * ADR 034) : chaque IBAN passe à la clé courante, reste lié à son mandat, et
 * un mandat qu'on ne sait pas lire est signalé, pas perdu. Sous l'identité
 * applicative.
 */
describe('rechiffrement des mandats SEPA', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const CLIENT = '01a00000-0000-7000-8000-0000000f5c01'
  const AUTRE = '01a00000-0000-7000-8000-0000000f5c02'
  const IBAN = 'FR7630006000011234567890189'

  const cle1 = randomBytes(32)
  const cle2 = randomBytes(32)
  const avant: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, cle1]]) }
  const apres: DocumentKeyring = { currentVersion: 2, keys: new Map([[1, cle1], [2, cle2]]) }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const mandat = async (clientId: string, reference: string, keyring = avant) => {
    const sealed = sealIban(IBAN, { tenantId: DEFAULT_TENANT_ID, reference }, keyring)
    return asTenant((tx) =>
      insertReturning(tx, sepaMandates, {
        clientId,
        reference,
        debtorName: 'Atelier Durand',
        ibanCiphertext: sealed.ciphertext,
        ibanKeyVersion: sealed.keyVersion,
        ibanLast4: sealed.last4,
        signedOn: '2026-09-01',
      }),
    )
  }

  const relire = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(sepaMandates).where(eq(sepaMandates.id, id)))
    return row
  }

  const rechiffrer = (keyring: DocumentKeyring, apply = true) =>
    rekeyMandateIbans({ database: bases.app.db, tenantId: DEFAULT_TENANT_ID, keyring, apply })

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant((tx) =>
      tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Atelier Durand'), (${AUTRE}, 'Boulangerie Petit')`),
    )
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.fermer()
  })

  it('compte à blanc, puis rechiffre chaque IBAN avec la clé courante, sans changer de mandat', async () => {
    const actif = await mandat(CLIENT, 'RUM-2026-0001')
    const revoque = await mandat(AUTRE, 'RUM-2026-0002')
    await asTenant((tx) =>
      tx.update(sepaMandates).set({ status: 'revoked', revokedOn: '2026-09-30' }).where(eq(sepaMandates.id, revoque.id)),
    )

    const essai = await rechiffrer(apres, false)
    assert.deepEqual(essai.pending, { 'clé 1': 2 })
    assert.equal(essai.rotated, 0)
    assert.equal((await relire(actif.id)).ibanKeyVersion, 1)

    const bilan = await rechiffrer(apres)
    assert.equal(bilan.rotated, 2)
    assert.deepEqual(bilan.failed, [])
    for (const { id, reference } of [actif, revoque]) {
      const row = await relire(id)
      assert.equal(row.ibanKeyVersion, 2)
      assert.equal(row.ibanLast4, '0189')
      // Lisible avec la seule nouvelle clé : l'ancienne peut quitter le trousseau.
      const seule = { currentVersion: 2, keys: new Map([[2, cle2]]) }
      assert.equal(openIban(row.ibanCiphertext, row.ibanKeyVersion, { tenantId: DEFAULT_TENANT_ID, reference }, seule), IBAN)
    }

    // Rejoué, il n'y a plus rien à faire.
    const rejoue = await rechiffrer(apres)
    assert.deepEqual(rejoue.pending, {})
    assert.equal(rejoue.rotated, 0)
  })

  it('signale un mandat qu’il ne sait pas lire, et traite les autres', async () => {
    const lisible = await mandat(CLIENT, 'RUM-2026-0003')
    // Chiffré avec une clé que le trousseau n'a plus.
    const orphelin = await mandat(AUTRE, 'RUM-2026-0004', { currentVersion: 3, keys: new Map([[3, randomBytes(32)]]) })
    const bilan = await rechiffrer(apres)
    assert.equal(bilan.rotated, 1)
    assert.equal(bilan.failed.length, 1)
    assert.equal(bilan.failed[0].id, orphelin.id)
    assert.match(bilan.failed[0].error, /version 3/)
    assert.equal((await relire(lisible.id)).ibanKeyVersion, 2)
    assert.equal((await relire(orphelin.id)).ibanKeyVersion, 3)
  })
})
