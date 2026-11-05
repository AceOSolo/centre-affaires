import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'

import { inboxCount } from '../../app/(admin)/aujourdhui/journee.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { permissionsOf } from '../../lib/auth/permissions.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { countPendingMailRequests } from '../courrier/demandes-queries.ts'
import { listOfferRequests } from '../facturation/offres-portail.ts'
import { awaitsReception } from '../facturation/propositions.ts'
import { listProposals } from '../facturation/propositions-queries.ts'
import { listPendingBookings } from '../reservations/queries.ts'
import { inboxFeed } from './cloche-queries.ts'

/**
 * Cloche de l'équipe (ADR 070), contre la base : elle montre ce qui attend
 * dans « Demandes », au même nombre que son compteur, et une demande en sort
 * dès qu'elle est traitée. Chaque membre n'y voit que ce que ses droits lui
 * ouvrent, et rien d'un autre centre.
 */
describe('cloche de l’équipe : les demandes à traiter', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000c1c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000c1d01'
  const CAMILLE = '01a00000-0000-7000-8000-0000000c1e01'
  const SALLE = '01a00000-0000-7000-8000-0000000c1b01'
  const AUTRE_CENTRE = '01a00000-0000-7000-8000-0000000c1a01'
  const SALLE_VOISINE = '01a00000-0000-7000-8000-0000000c1b09'

  const accueil = permissionsOf('staff')

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  const creer = async (ecrire: (tx: Transaction, id: string) => Promise<unknown>) => {
    const nouveau = uuidv7()
    await asTenant((tx) => ecrire(tx, nouveau))
    return nouveau
  }

  let heure = 6
  const reserver = (colonnes: SQL, valeurs: SQL) => {
    heure += 1
    const minuit = new Date()
    minuit.setUTCHours(0, 0, 0, 0)
    const debut = new Date(minuit.getTime() + (3 * 24 + heure) * 3_600_000)
    const fin = new Date(debut.getTime() + 3_600_000)
    return creer((tx, id) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, title, starts_at, ends_at, ${colonnes})
        values (${id}, ${SALLE}, 'Réunion', ${debut}, ${fin}, ${valeurs})`),
    )
  }

  let numero = 0
  const devis = (colonnes: SQL, valeurs: SQL) => {
    numero += 1
    return creer((tx, id) =>
      tx.execute(sql`
        insert into proposals (id, number, ${colonnes}, answers)
        values (${id}, ${`DV-CLOCHE-${numero}`}, ${valeurs}, '{}')`),
    )
  }

  /** Le nombre de la coque et d'« Aujourd'hui », lu comme eux (`layout.tsx`). */
  const compteurDeLaCoque = async () => {
    const [pending, drafts, offers, mail] = await Promise.all([
      listPendingBookings(),
      listProposals({ statuses: ['draft'] }),
      listOfferRequests(),
      countPendingMailRequests(),
    ])
    return inboxCount({
      pendingBookings: pending.length,
      proposalsToComplete: drafts.filter(awaitsReception).length,
      offerRequests: offers,
      mailRequests: mail.total,
    })
  }

  const tables = [
    'proposal_lines',
    'proposals',
    'bookings',
    'offer_requests',
    'offers',
    'mail_requests',
    'mail_items',
    'client_members',
    'clients',
    'resources',
    'staff_members',
  ]

  /** Une demande de chaque sorte, comme elles arrivent des clients et du site. */
  const deposer = async () => {
    const reservation = await reserver(sql`client_id, channel, booked_by_member_id`, sql`${DURAND}, 'client', ${JEANNE}`)
    const parProduit = await reserver(
      sql`channel, status, requester_name, requester_email, requester_phone`,
      sql`'public', 'pending', 'Camille Rousseau', 'camille@exemple.fr', '0600000000'`,
    )
    // Le devis né avec la demande par produit (ADR 043) : il attend avec elle.
    await devis(
      sql`product, channel, booking_id, requester_name, requester_email`,
      sql`'espace', 'public', ${parProduit}, 'Camille Rousseau', 'camille@exemple.fr'`,
    )
    const domiciliation = await devis(
      sql`product, channel, requester_name, requester_email, requester_company`,
      sql`'domiciliation', 'public', 'Camille Rousseau', 'camille@exemple.fr', 'Rousseau Conseil'`,
    )
    const offre = await creer((tx, id) =>
      tx.execute(sql`insert into offers (id, name, client_visible) values (${id}, 'Domiciliation premium', 1)`),
    )
    const demandeOffre = await creer((tx, id) =>
      tx.execute(sql`
        insert into offer_requests (id, client_id, offer_id, requested_by_member_id)
        values (${id}, ${DURAND}, ${offre}, ${JEANNE})`),
    )
    const pli = await creer((tx, id) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, kind, sender, received_at)
        values (${id}, ${DURAND}, 'recommande', 'URSSAF', '2026-09-30 22:30:00.000')`),
    )
    const courrier = await creer((tx, id) =>
      tx.execute(sql`
        insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
        values (${id}, ${pli}, ${DURAND}, 'open_and_scan', ${JEANNE})`),
    )
    return { reservation, parProduit, domiciliation, demandeOffre, courrier }
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les files de « Demandes » lisent la base de l'application.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, ...tables)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.exemple', 'Camille')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand')`)
      await tx.execute(sql`insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-CLO', 'Salle Atlas')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await viderTables(bases.owner, ...tables)
    await lire('delete from tenants where id = ?', [AUTRE_CENTRE])
    await bases.fermer()
  })

  it('montre chaque demande en attente, au nombre de « Demandes »', async () => {
    const ids = await deposer()
    const feed = await inboxFeed(accueil)

    assert.equal(feed.count, 5)
    assert.equal(feed.count, await compteurDeLaCoque())
    const par = (id: string) => feed.items.find((item) => item.id === id)

    assert.deepEqual(
      [par(ids.reservation)?.label, par(ids.reservation)?.who, par(ids.reservation)?.href],
      ['Demande de réservation', 'Atelier Durand', `/demandes?produit=salles#demande-${ids.reservation}`],
    )
    assert.match(String(par(ids.reservation)?.summary), /^Salle Atlas · \w+ \d+ \w+ \d{4}, de \d{2}:\d{2} à \d{2}:\d{2}$/)
    // Le devis né avec la demande ne compte pas deux fois : la demande dit « de devis ».
    assert.deepEqual(
      [par(ids.parProduit)?.label, par(ids.parProduit)?.who],
      ['Demande de devis', 'Camille Rousseau'],
    )
    assert.deepEqual(
      [par(ids.domiciliation)?.label, par(ids.domiciliation)?.who, par(ids.domiciliation)?.href],
      ['Demande de domiciliation', 'Rousseau Conseil', `/demandes?produit=domiciliation#devis-${ids.domiciliation}`],
    )
    assert.deepEqual(
      [par(ids.demandeOffre)?.label, par(ids.demandeOffre)?.summary, par(ids.demandeOffre)?.href],
      ['Offre demandée', 'Domiciliation premium', `/demandes?produit=autres#offre-${ids.demandeOffre}`],
    )
    // Ni l'expéditeur, ni rien de ce que le pli contient.
    assert.deepEqual(
      [par(ids.courrier)?.label, par(ids.courrier)?.summary, par(ids.courrier)?.state],
      ['Demande de courrier', 'Ouverture et numérisation · Recommandé du 1 oct. 2026 à 00:30', null],
    )
    assert.doesNotMatch(JSON.stringify(feed), /URSSAF/)
  })

  it('perd une demande dès qu’elle est traitée, quel que soit le membre', async () => {
    const ids = await deposer()

    await asTenant((tx) => tx.execute(sql`update bookings set status = 'confirmed' where id = ${ids.reservation}`))
    // Prise en charge : quelqu'un s'en occupe, elle reste jusqu'à ce qu'elle soit faite.
    await asTenant((tx) =>
      tx.execute(sql`
        update mail_requests set status = 'in_progress', started_by_staff_id = ${CAMILLE} where id = ${ids.courrier}`),
    )
    let feed = await inboxFeed(accueil)
    assert.equal(feed.count, 4)
    assert.equal(feed.count, await compteurDeLaCoque())
    assert.equal(feed.items.find((item) => item.id === ids.reservation), undefined)
    assert.equal(feed.items.find((item) => item.id === ids.courrier)?.state, 'Prise en charge')

    await asTenant((tx) =>
      tx.execute(sql`
        update mail_requests
           set status = 'refused', refusal_reason = 'Pli introuvable', refused_by_staff_id = ${CAMILLE}
         where id = ${ids.courrier}`),
    )
    feed = await inboxFeed(accueil)
    assert.equal(feed.count, 3)
    assert.deepEqual(
      feed.items.map((item) => item.id).sort(),
      [ids.parProduit, ids.domiciliation, ids.demandeOffre].sort(),
    )
  })

  it('ne montre à un membre que ce que ses droits lui ouvrent', async () => {
    const ids = await deposer()
    const courrierSeul = await inboxFeed(['courrier.gerer'])
    assert.equal(courrierSeul.count, 1)
    assert.deepEqual(
      courrierSeul.items.map((item) => item.id),
      [ids.courrier],
    )
    assert.deepEqual(await inboxFeed(['espace-client.personnel']), { count: 0, items: [] })
  })

  it('ne montre rien d’un autre centre', async () => {
    await lire(
      `insert into tenants (id, name, slug) values (?, 'Centre voisin', 'centre-voisin-cloche')
       on duplicate key update id = id`,
      [AUTRE_CENTRE],
    )
    await withTenant(
      AUTRE_CENTRE,
      async (tx) => {
        await tx.execute(sql`
          insert into resources (id, tenant_id, resource_type, code, name)
          values (${SALLE_VOISINE}, ${AUTRE_CENTRE}, 'salle', 'S-VOI', 'Salle voisine')`)
        await tx.execute(sql`
          insert into bookings (id, tenant_id, resource_id, title, starts_at, ends_at, channel, status, requester_name)
          values (${uuidv7()}, ${AUTRE_CENTRE}, ${SALLE_VOISINE}, 'Voisine', '2027-01-04 09:00:00', '2027-01-04 10:00:00',
                  'public', 'pending', 'Voisin')`)
      },
      bases.app.db,
    )
    try {
      assert.deepEqual(await inboxFeed(accueil), { count: 0, items: [] })
    } finally {
      await lire('delete from bookings where tenant_id = ?', [AUTRE_CENTRE])
      await lire('delete from resources where tenant_id = ?', [AUTRE_CENTRE])
    }
  })
})
