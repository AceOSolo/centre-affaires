import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_CONTRACT_OCCUPATION_LOCKED,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { bookings, isOpenEndedBooking, OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'

/**
 * Occupation des ressources sous contrat (R02, R04, décision D6, ADR 018).
 *
 * Un bureau ou une boîte aux lettres loué par un contrat doit être occupé dans
 * tous les calendriers, ne jamais pouvoir être loué deux fois, ni réservé à
 * l'heure pendant le contrat. La garantie vient de la base : le trigger de
 * `contracts` matérialise la période en une ligne de `bookings`, et la
 * contrainte d'exclusion de la décision 3 fait le reste.
 *
 * Tout est éprouvé sous `app_centre`, comme l'application l'écrit.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('occupation des ressources sous contrat', { skip: raison }, () => {
  const notices: string[] = []
  const owner = createDatabase(ownerUrl ?? '', {
    onnotice: (notice) => notices.push(String(notice.message)),
  })
  const app = createDatabase(appUrl ?? '')

  const CLIENT = '01a00000-0000-7000-8000-0000000c0c01'
  const AUTRE_CLIENT = '01a00000-0000-7000-8000-0000000c0c02'
  const BUREAU = '01a00000-0000-7000-8000-0000000c0b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000c0b02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f7'
  const CLIENT_AILLEURS = '01a00000-0000-7000-8000-0000000c0c09'
  const SALLE_AILLEURS = '01a00000-0000-7000-8000-0000000c0b09'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Un contrat de bureau, en brouillon par défaut, comme le crée l'écran. */
  const contrat = async ({
    reference = 'BUR-2026-001',
    clientId = CLIENT,
    resourceId = BUREAU as string | null,
    startsOn = '2026-03-01',
    endsOn = '2026-06-30' as string | null,
    status = 'draft',
  } = {}): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into contracts
          (client_id, reference, contract_type, status, starts_on, ends_on, amount_cents, resource_id)
        values
          (${clientId}, ${reference}, 'bureau', ${status}, ${startsOn}, ${endsOn}, 90000, ${resourceId})
        returning id
      `),
    )
    return row.id as string
  }

  const activer = (id: string) =>
    asTenant((tx) => tx.execute(sql`update contracts set status = 'active' where id = ${id}`))

  const resilier = (id: string, terminatedOn: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        update contracts set status = 'terminated', terminated_on = ${terminatedOn} where id = ${id}
      `),
    )

  /** L'occupation d'un contrat, lue comme le planning la lit : par Drizzle. */
  const occupation = async (contractId: string) => {
    const [row] = await asTenant((tx) =>
      tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.contractId, contractId), eq(bookings.kind, 'contract'))),
    )
    return row
  }

  /** Réservation horaire posée par l'équipe. */
  const reserver = (start: string, end: string, resourceId = BUREAU) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, channel, starts_at, ends_at, title)
        values (${resourceId}, 'staff', ${start}, ${end}, 'Rendez-vous')
      `),
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    notices.length = 0
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name) values (${CLIENT}, 'Acme SAS'), (${AUTRE_CLIENT}, 'Beta SARL')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1'),
          (${AUTRE_BUREAU}, 'bureau', 'BUR-02', 'Bureau 2')`)
    })
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('période occupée', () => {
    it('un brouillon n’occupe rien', async () => {
      const id = await contrat()
      assert.equal(await occupation(id), undefined)
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z')
    })

    it('l’activation occupe la ressource, de minuit à minuit heure du centre', async () => {
      const id = await contrat()
      await activer(id)

      const ligne = await occupation(id)
      assert.equal(ligne.status, 'confirmed')
      assert.equal(ligne.kind, 'contract')
      assert.equal(ligne.channel, 'staff')
      assert.equal(ligne.resourceId, BUREAU)
      assert.equal(ligne.clientId, CLIENT)
      assert.equal(ligne.title, 'Contrat BUR-2026-001')
      // 1er mars à 00h00 à Paris (UTC+1) ; le 30 juin est compris jusqu'à
      // minuit le 1er juillet, en heure d'été (UTC+2).
      assert.equal(ligne.startsAt.toISOString(), '2026-02-28T23:00:00.000Z')
      assert.equal(ligne.endsAt.toISOString(), '2026-06-30T22:00:00.000Z')
    })

    it('date l’occupation dans le fuseau du centre, pas en UTC', async () => {
      await owner.client`
        insert into tenants (id, name, slug, timezone)
        values (${AUTRE_CENTRE}, 'Centre de Tokyo', 'tokyo', 'Asia/Tokyo')`
      const [row] = await asTenant(async (tx) => {
        await tx.execute(sql`insert into clients (id, name) values (${CLIENT_AILLEURS}, 'Acme KK')`)
        await tx.execute(sql`
          insert into resources (id, resource_type, code, name)
          values (${SALLE_AILLEURS}, 'bureau', 'TKY-01', 'Bureau Tokyo')`)
        await tx.execute(sql`
          insert into contracts
            (client_id, reference, contract_type, status, starts_on, ends_on, amount_cents, resource_id)
          values (${CLIENT_AILLEURS}, 'TKY-1', 'bureau', 'active', '2026-03-01', '2026-03-31', 1000, ${SALLE_AILLEURS})`)
        return tx.execute(sql`
          select starts_at, ends_at from bookings where kind = 'contract'`)
      }, AUTRE_CENTRE)
      // Minuit à Tokyo (UTC+9) : la veille à 15h00 UTC.
      assert.equal(new Date(row.starts_at as string).toISOString(), '2026-02-28T15:00:00.000Z')
      assert.equal(new Date(row.ends_at as string).toISOString(), '2026-03-31T15:00:00.000Z')
    })

    it('un contrat sans terme occupe sans fin, et se lit en Date valide', async () => {
      const id = await contrat({ endsOn: null })
      await activer(id)

      const ligne = await occupation(id)
      // `infinity` deviendrait une Invalid Date côté Node : la borne lointaine
      // reste un instant ordinaire, comparable et formatable.
      assert.ok(!Number.isNaN(ligne.endsAt.getTime()))
      assert.equal(ligne.endsAt.getTime(), OPEN_ENDED_BOOKING_END.getTime())
      assert.ok(isOpenEndedBooking(ligne))

      const [borne] = await asTenant((tx) => tx.execute(sql`select booking_open_end() as fin`))
      assert.equal(new Date(borne.fin as string).getTime(), OPEN_ENDED_BOOKING_END.getTime())

      assert.equal(
        await errorCode(() => reserver('2031-05-12T08:00:00Z', '2031-05-12T09:00:00Z')),
        PG_EXCLUSION_VIOLATION,
      )
    })

    it('suit le client du contrat', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) =>
        tx.execute(sql`update contracts set client_id = ${AUTRE_CLIENT} where id = ${id}`),
      )
      assert.equal((await occupation(id)).clientId, AUTRE_CLIENT)
    })

    it('ne crée qu’une occupation par contrat, quelles que soient les modifications', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) => tx.execute(sql`update contracts set notes = 'Clés remises' where id = ${id}`))
      await asTenant((tx) => tx.execute(sql`update contracts set ends_on = '2026-09-30' where id = ${id}`))
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from bookings where contract_id = ${id}`),
      )
      assert.equal(row.n, 1)
    })

    it('un contrat créé directement actif occupe aussitôt', async () => {
      const id = await contrat({ status: 'active' })
      assert.equal((await occupation(id)).status, 'confirmed')
    })
  })

  describe('anti-double-location', () => {
    it('refuse une réservation horaire pendant le contrat', async () => {
      await activer(await contrat())
      assert.equal(
        await errorCode(() => reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z')),
        PG_EXCLUSION_VIOLATION,
      )
      // Le dernier jour compte en entier : 23h00 le 30 juin, heure de Paris.
      assert.equal(
        await errorCode(() => reserver('2026-06-30T21:00:00Z', '2026-06-30T21:30:00Z')),
        PG_EXCLUSION_VIOLATION,
      )
    })

    it('accepte une réservation horaire dès le lendemain du terme', async () => {
      await activer(await contrat())
      // 1er juillet, 00h00 à 01h00 à Paris : bornes [) jointives.
      await reserver('2026-06-30T22:00:00Z', '2026-06-30T23:00:00Z')
      // Et sur une autre ressource pendant le contrat.
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', AUTRE_BUREAU)
    })

    it('refuse un second contrat actif sur la même ressource', async () => {
      await activer(await contrat())
      const second = await contrat({ reference: 'BUR-2026-002', clientId: AUTRE_CLIENT, startsOn: '2026-05-01', endsOn: null })

      assert.equal(await errorCode(() => activer(second)), PG_EXCLUSION_VIOLATION)
      // L'activation échoue entière : le contrat reste un brouillon.
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select status from contracts where id = ${second}`),
      )
      assert.equal(row.status, 'draft')
      assert.equal(await occupation(second), undefined)
    })

    it('refuse l’activation sur un créneau déjà réservé à l’heure', async () => {
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z')
      const id = await contrat()
      assert.equal(await errorCode(() => activer(id)), PG_EXCLUSION_VIOLATION)
    })

    it('départage deux activations concurrentes sur la même ressource', async () => {
      const premier = await contrat()
      const second = await contrat({ reference: 'BUR-2026-002', clientId: AUTRE_CLIENT })
      const resultats = await Promise.allSettled([activer(premier), activer(second)])

      assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from bookings where kind = 'contract'`),
      )
      assert.equal(row.n, 1)
    })

    it('laisse deux contrats successifs sur la même ressource', async () => {
      await activer(await contrat())
      await activer(
        await contrat({ reference: 'BUR-2026-002', clientId: AUTRE_CLIENT, startsOn: '2026-07-01', endsOn: null }),
      )
    })
  })

  describe('fin, archivage et modifications', () => {
    it('la résiliation libère la ressource le lendemain de la date de résiliation', async () => {
      const id = await contrat({ endsOn: null })
      await activer(id)
      await resilier(id, '2026-04-15')

      const ligne = await occupation(id)
      assert.equal(ligne.status, 'confirmed')
      // Le 15 avril reste occupé, jusqu'à minuit heure de Paris.
      assert.equal(ligne.endsAt.toISOString(), '2026-04-15T22:00:00.000Z')
      assert.equal(
        await errorCode(() => reserver('2026-04-15T15:00:00Z', '2026-04-15T16:00:00Z')),
        PG_EXCLUSION_VIOLATION,
      )
      await reserver('2026-04-16T07:00:00Z', '2026-04-16T08:00:00Z')
      // Et un nouveau contrat peut prendre le bureau.
      await activer(
        await contrat({ reference: 'BUR-2026-002', clientId: AUTRE_CLIENT, startsOn: '2026-04-17', endsOn: null }),
      )
    })

    it('une résiliation antérieure au début annule l’occupation', async () => {
      const id = await contrat()
      await activer(id)
      await resilier(id, '2026-02-15')
      const ligne = await occupation(id)
      assert.equal(ligne.status, 'cancelled')
      assert.equal(ligne.cancellationReason, 'Contrat résilié avant son début')
    })

    it('l’archivage annule l’occupation, la ligne reste', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = now() where id = ${id}`))

      const ligne = await occupation(id)
      assert.equal(ligne.status, 'cancelled')
      assert.ok(ligne.cancelledAt)
      assert.equal(ligne.cancellationReason, 'Contrat archivé')
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z')
    })

    it('le désarchivage rétablit l’occupation', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = now() where id = ${id}`))
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = null where id = ${id}`))
      const ligne = await occupation(id)
      assert.equal(ligne.status, 'confirmed')
      assert.equal(ligne.cancelledAt, null)
    })

    it('changer de ressource déplace l’occupation et libère l’ancienne', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) =>
        tx.execute(sql`update contracts set resource_id = ${AUTRE_BUREAU} where id = ${id}`),
      )
      assert.equal((await occupation(id)).resourceId, AUTRE_BUREAU)
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', BUREAU)
    })

    it('retirer la ressource annule l’occupation', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) => tx.execute(sql`update contracts set resource_id = null where id = ${id}`))
      assert.equal((await occupation(id)).cancellationReason, 'Ressource retirée du contrat')
    })

    it('changer les dates met l’occupation à jour', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) =>
        tx.execute(sql`update contracts set starts_on = '2026-04-01', ends_on = '2026-04-30' where id = ${id}`),
      )
      const ligne = await occupation(id)
      assert.equal(ligne.startsAt.toISOString(), '2026-03-31T22:00:00.000Z')
      assert.equal(ligne.endsAt.toISOString(), '2026-04-30T22:00:00.000Z')
      await reserver('2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z')
    })
  })

  describe('l’occupation ne s’écrit qu’à travers son contrat', () => {
    it('refuse de l’annuler, la déplacer, la modifier ou l’effacer directement', async () => {
      const id = await contrat()
      await activer(id)
      const ecritures = [
        sql`update bookings set status = 'cancelled', cancelled_at = now() where contract_id = ${id}`,
        sql`update bookings set starts_at = starts_at + interval '1 day' where contract_id = ${id}`,
        sql`update bookings set client_id = null where contract_id = ${id}`,
        sql`delete from bookings where contract_id = ${id}`,
      ]
      for (const ecriture of ecritures) {
        assert.equal(
          await errorCode(() => asTenant((tx) => tx.execute(ecriture))),
          PG_CONTRACT_OCCUPATION_LOCKED,
        )
      }
      assert.equal((await occupation(id)).status, 'confirmed')
    })

    it('refuse une occupation fabriquée hors contrat', async () => {
      const id = await contrat()
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, contract_id, kind, channel, starts_at, ends_at, title)
            values (${AUTRE_BUREAU}, ${id}, 'contract', 'staff', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', 'Fausse')
          `),
        ),
      )
      assert.equal(code, PG_CONTRACT_OCCUPATION_LOCKED)
    })

    it('refuse de transformer une réservation en occupation', async () => {
      await reserver('2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update bookings set kind = 'contract'`)),
      )
      assert.equal(code, PG_CONTRACT_OCCUPATION_LOCKED)
    })

    it('laisse les autres réservations s’annuler normalement', async () => {
      await activer(await contrat())
      await reserver('2026-07-02T07:00:00Z', '2026-07-02T08:00:00Z')
      await asTenant((tx) =>
        tx.execute(sql`
          update bookings set status = 'cancelled', cancelled_at = now() where kind = 'booking'`),
      )
    })
  })

  describe('rattachement d’une réservation à un contrat (R05)', () => {
    it('accepte une réservation horaire rattachée à un contrat du centre', async () => {
      const id = await contrat({ resourceId: null })
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, contract_id, client_id, channel, starts_at, ends_at, title)
          values (${BUREAU}, ${id}, ${CLIENT}, 'staff', '2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', 'Réunion incluse')
        `),
      )
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from bookings where contract_id = ${id} and kind = 'booking'`),
      )
      assert.equal(row.n, 1)
    })

    it('refuse le contrat d’un autre centre', async () => {
      const id = await contrat({ resourceId: null })
      await owner.client`
        insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-occ')`
      const code = await errorCode(() =>
        asTenant(async (tx) => {
          await tx.execute(sql`
            insert into resources (id, resource_type, code, name)
            values (${SALLE_AILLEURS}, 'salle', 'X-1', 'Salle ailleurs')`)
          await tx.execute(sql`
            insert into bookings (resource_id, contract_id, channel, starts_at, ends_at, title)
            values (${SALLE_AILLEURS}, ${id}, 'staff', '2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', 'Fuite')`)
        }, AUTRE_CENTRE),
      )
      assert.equal(code, PG_FOREIGN_KEY_VIOLATION)
    })

    it('exige un contrat sur toute occupation', async () => {
      // Même le chemin du trigger ne peut pas poser une occupation orpheline :
      // la contrainte `check` tient après le garde.
      const code = await errorCode(() =>
        owner.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.contract_occupation_sync', 'on', true)`)
          await tx.execute(sql`
            insert into bookings (tenant_id, resource_id, kind, channel, starts_at, ends_at, title)
            values (${DEFAULT_TENANT_ID}, ${BUREAU}, 'contract', 'staff', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', 'Orpheline')`)
        }),
      )
      assert.equal(code, PG_CHECK_VIOLATION)
    })
  })

  describe('reprise des contrats existants', () => {
    /**
     * Simule des contrats posés avant la migration 0026 : le trigger est
     * suspendu le temps de les écrire, comme s'il n'avait pas encore existé.
     */
    const contratsAnterieurs = async (run: () => Promise<void>) => {
      await owner.client`alter table contracts disable trigger contracts_sync_occupation`
      try {
        await run()
      } finally {
        await owner.client`alter table contracts enable trigger contracts_sync_occupation`
      }
    }

    it('pose l’occupation des contrats actifs et résiliés', async () => {
      let actif = ''
      let resilie = ''
      await contratsAnterieurs(async () => {
        actif = await contrat({ status: 'active', endsOn: null })
        resilie = await contrat({
          reference: 'BUR-2025-001',
          resourceId: AUTRE_BUREAU,
          startsOn: '2025-01-01',
          endsOn: null,
        })
        await asTenant((tx) =>
          tx.execute(sql`
            update contracts set status = 'terminated', terminated_on = '2025-06-30' where id = ${resilie}`),
        )
        await contrat({ reference: 'BUR-2026-009', resourceId: AUTRE_BUREAU, status: 'draft' })
      })

      const [row] = await owner.client`select backfill_contract_occupations() as skipped`
      assert.equal(row.skipped, 0)
      assert.equal((await occupation(actif)).status, 'confirmed')
      assert.equal((await occupation(resilie)).endsAt.toISOString(), '2025-06-30T22:00:00.000Z')
      const [n] = await owner.client`select count(*)::int as n from bookings where kind = 'contract'`
      assert.equal(n.n, 2)
    })

    it('signale un chevauchement au lieu d’échouer, puis se rejoue une fois résolu', async () => {
      let second = ''
      await contratsAnterieurs(async () => {
        await contrat({ status: 'active', startsOn: '2026-01-01', endsOn: null })
        second = await contrat({
          reference: 'BUR-2026-002',
          clientId: AUTRE_CLIENT,
          status: 'active',
          startsOn: '2026-05-01',
          endsOn: null,
        })
      })

      const [row] = await owner.client`select backfill_contract_occupations() as skipped`
      assert.equal(row.skipped, 1)
      assert.equal(await occupation(second), undefined)
      assert.ok(notices.some((message) => message.includes('BUR-2026-002')))

      // L'équipe tranche : le second contrat passe sur l'autre bureau.
      await contratsAnterieurs(() =>
        asTenant(async (tx) => {
          await tx.execute(sql`update contracts set resource_id = ${AUTRE_BUREAU} where id = ${second}`)
        }),
      )
      const [rejoue] = await owner.client`select backfill_contract_occupations() as skipped`
      assert.equal(rejoue.skipped, 0)
      assert.equal((await occupation(second)).resourceId, AUTRE_BUREAU)
    })

    it('n’est pas ouverte au rôle applicatif', async () => {
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`select backfill_contract_occupations()`)),
      )
      assert.equal(code, '42501')
    })
  })
})
