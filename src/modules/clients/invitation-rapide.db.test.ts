import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { createInvitedClient, quickInviteClientName } from './invitation-rapide.ts'

/**
 * « Inviter un client » de l'écran Comptes (ADR 068) : une adresse suffit à
 * créer la fiche prospect et son accès ; une adresse qui a déjà un accès en
 * cours n'en reçoit pas un second.
 */
describe('invitation rapide d’un client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  const options = () => ({ database: bases.app.db })
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'client_members', 'clients')
  })

  after(async () => {
    await viderTables(bases.owner, 'client_members', 'clients')
    await bases.fermer()
  })

  it('nomme la fiche d’après l’entreprise, sinon la personne, sinon l’adresse', () => {
    const base = { email: ' nina@exemple.fr ', fullName: null, company: null }
    assert.equal(quickInviteClientName({ ...base, company: ' Atelier Nina ', fullName: 'Nina Roy' }), 'Atelier Nina')
    assert.equal(quickInviteClientName({ ...base, fullName: 'Nina Roy' }), 'Nina Roy')
    assert.equal(quickInviteClientName({ ...base, company: '  ' }), 'nina@exemple.fr')
  })

  it('crée une fiche prospect et l’accès de la personne, pas encore relié à un compte', async () => {
    const issue = await createInvitedClient(
      { email: 'Nina@Exemple.fr', fullName: 'Nina Roy', company: 'Atelier Nina' },
      options(),
    )
    assert.equal(issue.ok, true)
    const [client] = await lire('select name, email, status, origin from clients where id = ?', [issue.clientId])
    assert.deepEqual(client, { name: 'Atelier Nina', email: 'nina@exemple.fr', status: 'prospect', origin: 'back_office' })
    const [acces] = await lire('select email, full_name, auth_user_id from client_members where client_id = ?', [
      issue.clientId,
    ])
    assert.deepEqual(acces, { email: 'nina@exemple.fr', full_name: 'Nina Roy', auth_user_id: null })
  })

  it('ne crée pas de seconde fiche pour une adresse qui a déjà un accès en cours', async () => {
    const premiere = await createInvitedClient({ email: 'nina@exemple.fr', fullName: null, company: 'Atelier Nina' }, options())
    const seconde = await createInvitedClient({ email: 'NINA@exemple.fr', fullName: null, company: 'Autre' }, options())
    assert.deepEqual(seconde, { ok: false, clientId: premiere.clientId, clientName: 'Atelier Nina' })
    assert.equal(Number((await lire('select count(*) as n from clients'))[0].n), 1)

    // Accès retiré : la personne peut être invitée de nouveau, sous une fiche neuve.
    await lire('update client_members set deleted_at = current_timestamp(3) where client_id = ?', [premiere.clientId])
    const troisieme = await createInvitedClient({ email: 'nina@exemple.fr', fullName: null, company: null }, options())
    assert.equal(troisieme.ok, true)
    assert.notEqual(troisieme.clientId, premiere.clientId)
  })
})
