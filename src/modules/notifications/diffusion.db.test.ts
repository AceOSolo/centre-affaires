import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { toutVider } from '../clients/test-support.ts'
import {
  createBroadcast,
  EmptyBroadcastError,
  findBroadcast,
  listBroadcastCandidates,
  listBroadcasts,
  previewBroadcast,
  sendBroadcast,
} from './diffusion.ts'
import type { BroadcastInput } from './diffusion-regles.ts'

/**
 * Message groupé aux clients (ADR 060), contre la base et sous l'identité
 * applicative :
 *
 * - le choix des destinataires : contrat en cours du jour, fiches vivantes ;
 * - la préférence « Informations du centre » coupée, respectée ;
 * - l'envoi par paquets, journalisé, et sa reprise après interruption ;
 * - l'historique : bilan, auteur, entreprise par entreprise ;
 * - les gardes de la base et le filtre du centre.
 */
describe('message aux clients', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DIRECTION = '01a00000-0000-7000-8000-0000000e1a01'
  const ALPHA = '01a00000-0000-7000-8000-0000000e1b01'
  const BETA = '01a00000-0000-7000-8000-0000000e1b02'
  const GAMMA = '01a00000-0000-7000-8000-0000000e1b03'
  const BUREAU = '01a00000-0000-7000-8000-0000000e1b04'
  const ANCIEN = '01a00000-0000-7000-8000-0000000e1b05'
  const FUTUR = '01a00000-0000-7000-8000-0000000e1b06'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000e1b07'
  const ALICE = '01a00000-0000-7000-8000-0000000e1c01'
  const ARTHUR = '01a00000-0000-7000-8000-0000000e1c02'
  const BRUNO = '01a00000-0000-7000-8000-0000000e1c03'
  const BERTHE = '01a00000-0000-7000-8000-0000000e1c04'
  const ARCHIBALD = '01a00000-0000-7000-8000-0000000e1c05'
  const AUTRE_CENTRE = '01a00000-0000-7000-8000-0000000e1d01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  /** Transport des tests : garde chaque message, refuse les adresses listées. */
  let envoyes: Message[] = []
  let refusees: string[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    const recipients = [...new Set(message.to.map((to) => to.trim().toLowerCase()))]
    const failed = recipients.filter((address) => refusees.includes(address))
    return failed.length > 0
      ? { status: 'failed', recipients, failed, error: `${failed.length} envoi en échec : 550 boîte inexistante` }
      : { status: 'sent', recipients, failed: [], error: null }
  }
  const options = {
    get database() {
      return bases.app.db
    },
  }
  // Des paquets de deux, sans pause : trois domiciliés font deux paquets.
  const envoi = {
    get database() {
      return bases.app.db
    },
    send,
    pauseMs: 0,
    batchSize: 2,
  }

  const message = (input: Partial<BroadcastInput> = {}): BroadcastInput => ({
    target: 'domiciliation',
    clientIds: [],
    subject: 'Fermeture du centre le 11 novembre',
    body: 'Le centre sera fermé le mercredi 11 novembre.',
    ...input,
  })

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    envoyes = []
    refusees = []
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into staff_members (id, email, full_name, role)
        values (${DIRECTION}, 'direction@centre.fr', 'Claire Direction', 'super_admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${ALPHA}, 'Alpha Conseil', 'active'), (${BETA}, 'Beta Studio', 'active'),
          (${GAMMA}, 'Gamma Sans Accès', 'active'), (${BUREAU}, 'Bureau Martin', 'active'),
          (${ANCIEN}, 'Ancien Domicilié', 'inactive'), (${FUTUR}, 'Futur Domicilié', 'prospect'),
          (${ARCHIVE}, 'Archivé Domicilié', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${ALICE}, ${ALPHA}, 'alice@alpha.fr', 'Alice', 'u-alice'),
          (${ARTHUR}, ${ALPHA}, 'arthur@alpha.fr', 'Arthur', 'u-arthur'),
          (${BRUNO}, ${BETA}, 'bruno@beta.fr', 'Bruno', 'u-bruno'),
          (${BERTHE}, ${BUREAU}, 'berthe@martin.fr', 'Berthe', 'u-berthe'),
          (${ARCHIBALD}, ${ARCHIVE}, 'archibald@archive.fr', 'Archibald', 'u-archibald')`)
      // Alpha, Beta, Gamma et l'archivé sont domiciliés aujourd'hui ; l'ancien ne l'est plus,
      // le futur pas encore ; le bureau Martin a un contrat de bureau.
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents) values
          (${ALPHA}, 'DOM-1', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${BETA}, 'DOM-2', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${GAMMA}, 'DOM-3', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${ARCHIVE}, 'DOM-4', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${FUTUR}, 'DOM-5', 'domiciliation', 'active', makedate(year(current_date()) + 1, 1), 3000),
          (${BUREAU}, 'BUR-1', 'bureau', 'active', makedate(year(current_date()) - 1, 1), 50000)`)
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on, amount_cents)
        values (${ANCIEN}, 'DOM-0', 'domiciliation', 'terminated', '2024-01-01', '2025-06-30', 3000)`)
      await tx.execute(sql`update clients set deleted_at = current_timestamp(3) where id = ${ARCHIVE}`)
      // Arthur et Bruno ont décoché « Informations du centre ».
      await tx.execute(sql`
        insert into notification_preferences (client_id, client_member_id, category, enabled) values
          (${ALPHA}, ${ARTHUR}, 'centre_info', 0), (${BETA}, ${BRUNO}, 'centre_info', 0),
          (${ALPHA}, ${ALICE}, 'mail_none', 0)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE_CENTRE])
    await bases.fermer()
  })

  describe('destinataires', () => {
    it('vise les domiciliés du jour : contrat en cours, fiche vivante', async () => {
      const { audience, sample } = await previewBroadcast(message(), options)
      assert.deepEqual(sample, ['Alpha Conseil', 'Beta Studio', 'Gamma Sans Accès'])
      // Alice seule recevra : Arthur et Bruno ont décoché, Gamma n'a personne.
      assert.deepEqual(audience, { companies: 3, people: 1, renounced: 2, unreached: 2 })
    })

    it('vise les clients des bureaux', async () => {
      const { audience, sample } = await previewBroadcast(message({ target: 'bureaux' }), options)
      assert.deepEqual(sample, ['Bureau Martin'])
      assert.deepEqual(audience, { companies: 1, people: 1, renounced: 0, unreached: 0 })
    })

    it('ne garde d’une sélection que les fiches vivantes du centre', async () => {
      const inconnue = '01a00000-0000-7000-8000-0000000e1bff'
      const { sample } = await previewBroadcast(
        message({ target: 'selection', clientIds: [BUREAU, ANCIEN, ARCHIVE, inconnue] }),
        options,
      )
      assert.deepEqual(sample, ['Ancien Domicilié', 'Bureau Martin'])
    })

    it('liste les fiches à cocher, les domiciliés d’abord', async () => {
      const candidates = await listBroadcastCandidates(options)
      assert.deepEqual(
        candidates.map((candidate) => [candidate.name, candidate.domiciled, candidate.offices, candidate.people]),
        [
          ['Alpha Conseil', true, false, 2],
          ['Beta Studio', true, false, 1],
          ['Gamma Sans Accès', true, false, 0],
          ['Ancien Domicilié', false, false, 0],
          ['Bureau Martin', false, true, 1],
          ['Futur Domicilié', false, false, 0],
        ],
      )
    })

    it('n’enregistre pas un message sans destinataire', async () => {
      await assert.rejects(
        createBroadcast(message({ target: 'selection', clientIds: [ARCHIVE] }), DIRECTION, options),
        EmptyBroadcastError,
      )
      assert.deepEqual(await lire('select id from client_broadcasts'), [])
    })
  })

  describe('envoi', () => {
    it('envoie par paquets par le moteur, préférences appliquées, chaque envoi journalisé', async () => {
      const { id, companies } = await createBroadcast(message(), DIRECTION, options)
      assert.equal(companies, 3)
      const tally = await sendBroadcast(id, envoi)
      assert.deepEqual(tally, {
        companies: 3,
        pending: 0,
        sent: 1,
        failed: 0,
        notConfigured: 0,
        skipped: 2,
        addresses: 1,
        failedAddresses: 0,
      })

      // Un seul courriel : à Alice, l'objet et le texte saisis, entourés du modèle.
      assert.equal(envoyes.length, 1)
      assert.deepEqual(envoyes[0].to, ['alice@alpha.fr'])
      assert.equal(envoyes[0].subject, 'Fermeture du centre le 11 novembre')
      assert.match(envoyes[0].text, /^Bonjour,\n\nLe centre sera fermé le mercredi 11 novembre\./)

      const journal = await lire(
        `select client_id, status, error, related_type, related_id, event
           from notification_deliveries order by client_id`,
      )
      assert.deepEqual(
        journal.map((row) => [row.client_id, row.status, row.event, row.related_type, row.related_id]),
        [
          [ALPHA, 'sent', 'client_broadcast', 'client_broadcast', id],
          [BETA, 'skipped', 'client_broadcast', 'client_broadcast', id],
          [GAMMA, 'skipped', 'client_broadcast', 'client_broadcast', id],
        ],
      )
      assert.match(String(journal[1].error), /Informations du centre/)
      assert.match(String(journal[2].error), /Aucune personne/)

      const [broadcast] = await lire('select completed_at from client_broadcasts where id = ?', [id])
      assert.ok(broadcast.completed_at, 'terminé')
    })

    it('compte les adresses refusées par le serveur SMTP', async () => {
      refusees = ['berthe@martin.fr']
      const { id } = await createBroadcast(message({ target: 'bureaux' }), DIRECTION, options)
      const tally = await sendBroadcast(id, envoi)
      assert.equal(tally?.failed, 1)
      assert.equal(tally?.failedAddresses, 1)
      const detail = await findBroadcast(id, options)
      assert.equal(detail?.recipients[0].status, 'failed')
      assert.match(detail?.recipients[0].error ?? '', /550/)
    })

    it('ne sert pas deux fois une entreprise : un envoi relancé ne fait rien de plus', async () => {
      const { id } = await createBroadcast(message({ target: 'selection', clientIds: [ALPHA, BUREAU] }), DIRECTION, options)
      await sendBroadcast(id, envoi)
      assert.equal(envoyes.length, 2)
      await sendBroadcast(id, envoi)
      assert.equal(envoyes.length, 2)
      assert.equal((await lire('select id from notification_deliveries')).length, 2)
    })

    it('reprend les entreprises d’un paquet interrompu, pas celles d’un paquet vivant', async () => {
      const { id } = await createBroadcast(message({ target: 'selection', clientIds: [ALPHA, BUREAU] }), DIRECTION, options)
      // Alpha a été pris par un paquet il y a vingt minutes, jamais terminé ;
      // Bureau Martin vient d'être pris par un paquet en cours.
      await bases.owner.client.query(
        `update client_broadcast_recipients
            set claim_token = uuid(),
                claimed_at = case client_id when ? then current_timestamp(3) - interval 20 minute
                                            else current_timestamp(3) end
          where broadcast_id = ?`,
        [ALPHA, id],
      )
      const tally = await sendBroadcast(id, envoi)
      assert.deepEqual(envoyes.map((sent) => sent.to), [['alice@alpha.fr']])
      assert.equal(tally?.pending, 1, 'le paquet vivant finit son travail')
      const [broadcast] = await lire('select completed_at from client_broadcasts where id = ?', [id])
      assert.equal(broadcast.completed_at, null)
    })
  })

  describe('historique', () => {
    it('dit la date, l’auteur, les destinataires et les échecs de chaque message', async () => {
      const premier = await createBroadcast(message({ subject: 'Travaux' }), DIRECTION, options)
      await sendBroadcast(premier.id, envoi)
      const second = await createBroadcast(message({ target: 'bureaux', subject: 'Nouveau service' }), DIRECTION, options)

      const { rows, total } = await listBroadcasts({ number: 1, size: 10 }, options)
      assert.equal(total, 2)
      assert.deepEqual(
        rows.map((row) => [row.subject, row.target, row.author, row.tally.companies, row.tally.sent, row.tally.skipped, row.tally.pending]),
        [
          ['Nouveau service', 'bureaux', 'Claire Direction', 1, 0, 0, 1],
          ['Travaux', 'domiciliation', 'Claire Direction', 3, 1, 2, 0],
        ],
      )
      assert.ok(rows[0].lastActivity >= rows[0].createdAt)

      const detail = await findBroadcast(premier.id, options)
      assert.equal(detail?.body, 'Le centre sera fermé le mercredi 11 novembre.')
      assert.deepEqual(
        detail?.recipients.map((recipient) => [recipient.clientName, recipient.status, recipient.addressCount]),
        [
          ['Alpha Conseil', 'sent', 1],
          ['Beta Studio', 'skipped', 0],
          ['Gamma Sans Accès', 'skipped', 0],
        ],
      )
      assert.equal(second.companies, 1)
    })

    it('ne lit que les messages du centre courant', async () => {
      const { id } = await createBroadcast(message(), DIRECTION, options)
      await bases.owner.client.query(
        `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-diffusion')
         on duplicate key update id = id`,
        [AUTRE_CENTRE],
      )
      assert.equal(await findBroadcast(id, { ...options, tenantId: AUTRE_CENTRE }), undefined)
      assert.equal((await listBroadcasts(undefined, { ...options, tenantId: AUTRE_CENTRE })).total, 0)
      assert.equal(await sendBroadcast(id, { ...envoi, tenantId: AUTRE_CENTRE }), null)
      assert.equal(envoyes.length, 0)
    })
  })

  describe('gardes de la base', () => {
    it('refuse toute écriture sous portée client', async () => {
      let code: string | undefined
      try {
        await withClientScope(
          DEFAULT_TENANT_ID,
          [ALPHA],
          (tx) =>
            tx.execute(sql`
              insert into client_broadcasts (subject, body, target, created_by)
              values ('Intrus', 'Texte', 'selection', ${DIRECTION})`),
          bases.app.db,
        )
      } catch (error) {
        code = dbErrorCode(error)
      }
      assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)
    })

    it('ne réécrit pas un message envoyé, ne remet pas en attente une entreprise servie, ne supprime rien', async () => {
      const { id } = await createBroadcast(message({ target: 'bureaux' }), DIRECTION, options)
      await sendBroadcast(id, envoi)
      await assert.rejects(
        asTenant((tx) => tx.execute(sql`update client_broadcasts set body = 'Autre texte' where id = ${id}`)),
        (error: unknown) => dbErrorCode(error) === 'CA017',
      )
      await assert.rejects(
        asTenant((tx) =>
          tx.execute(sql`
            update client_broadcast_recipients set status = 'pending', processed_at = null
             where broadcast_id = ${id}`),
        ),
        (error: unknown) => dbErrorCode(error) === 'CA017',
      )
      await assert.rejects(
        asTenant((tx) => tx.execute(sql`delete from client_broadcast_recipients where broadcast_id = ${id}`)),
        (error: unknown) => dbErrorCode(error) === DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })
})
