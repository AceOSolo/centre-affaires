import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, eq, sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_CONTRACT_OCCUPATION_LOCKED,
  DB_EXCLUSION_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { bookings, isOpenEndedBooking, OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'

/**
 * Occupation des ressources sous contrat (R02, R04, décision D6, ADR 018).
 *
 * Un bureau ou une boîte aux lettres loué par un contrat doit être occupé dans
 * tous les calendriers, ne jamais pouvoir être loué deux fois, ni réservé à
 * l'heure pendant le contrat. La garantie vient de la base : le trigger de
 * `contracts` (`contracts_after_*`, procédure `apply_contract_occupation`)
 * matérialise la période en une ligne de `bookings`, et le contrôle de
 * chevauchement de la décision 3 (triggers de `bookings`) fait le reste.
 *
 * Tout est éprouvé sous l'identité applicative, comme l'application l'écrit.
 */
/**
 * Instant d'une colonne `datetime` lue par un `select` brut : Drizzle rend la
 * chaîne `AAAA-MM-JJ hh:mm:ss.mmm`, en UTC (la connexion l'est).
 */
const instant = (value: unknown): Date =>
  value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)

describe('occupation des ressources sous contrat', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const CLIENT = '01a00000-0000-7000-8000-0000000c0c01'
  const AUTRE_CLIENT = '01a00000-0000-7000-8000-0000000c0c02'
  const BUREAU = '01a00000-0000-7000-8000-0000000c0b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000c0b02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f7'
  const CLIENT_AILLEURS = '01a00000-0000-7000-8000-0000000c0c09'
  const SALLE_AILLEURS = '01a00000-0000-7000-8000-0000000c0b09'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Nombre de lignes d'une requête `select count(*) as n …`. */
  const count = async (query: ReturnType<typeof sql>) => {
    const [rows] = (await asTenant((tx) => tx.execute(query))) as unknown as [{ n: number | string }[]]
    return Number(rows[0].n)
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
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into contracts
          (id, client_id, reference, contract_type, status, starts_on, ends_on, amount_cents, resource_id)
        values
          (${id}, ${clientId}, ${reference}, 'bureau', ${status}, ${startsOn}, ${endsOn}, 90000, ${resourceId})
      `),
    )
    return id
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
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'bookings',
      'contract_documents',
      'contract_amendments',
      'contract_lines',
      'contracts',
      'rate_plan_items',
      'rate_plans',
      'clients',
      'resources',
    )
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
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
    await bases.fermer()
  })

  describe('période occupée', () => {
    it('un brouillon n’occupe rien', async () => {
      const id = await contrat()
      assert.equal(await occupation(id), undefined)
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00')
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
      await bases.owner.client.query(
        'insert into tenants (id, name, slug, timezone) values (?, ?, ?, ?)',
        [AUTRE_CENTRE, 'Centre de Tokyo', 'tokyo', 'Asia/Tokyo'],
      )
      const [rows] = (await asTenant(async (tx) => {
        // Hors du centre par défaut, `tenant_id` se donne : la valeur par
        // défaut posée en base est celle du centre unique.
        await tx.execute(sql`
          insert into clients (id, tenant_id, name) values (${CLIENT_AILLEURS}, ${AUTRE_CENTRE}, 'Acme KK')`)
        await tx.execute(sql`
          insert into resources (id, tenant_id, resource_type, code, name)
          values (${SALLE_AILLEURS}, ${AUTRE_CENTRE}, 'bureau', 'TKY-01', 'Bureau Tokyo')`)
        await tx.execute(sql`
          insert into contracts
            (tenant_id, client_id, reference, contract_type, status, starts_on, ends_on, amount_cents, resource_id)
          values (${AUTRE_CENTRE}, ${CLIENT_AILLEURS}, 'TKY-1', 'bureau', 'active', '2026-03-01', '2026-03-31',
                  1000, ${SALLE_AILLEURS})`)
        return tx.execute(sql`
          select starts_at, ends_at from bookings where kind = 'contract' and tenant_id = ${AUTRE_CENTRE}`)
      }, AUTRE_CENTRE)) as unknown as [{ starts_at: Date; ends_at: Date }[]]
      // Minuit à Tokyo (UTC+9) : la veille à 15h00 UTC.
      assert.equal(instant(rows[0].starts_at).toISOString(), '2026-02-28T15:00:00.000Z')
      assert.equal(instant(rows[0].ends_at).toISOString(), '2026-03-31T15:00:00.000Z')
    })

    it('un contrat sans terme occupe sans fin, et se lit en Date valide', async () => {
      const id = await contrat({ endsOn: null })
      await activer(id)

      const ligne = await occupation(id)
      // MySQL n'a pas d'infini : la borne lointaine est un instant ordinaire,
      // comparable et formatable.
      assert.ok(!Number.isNaN(ligne.endsAt.getTime()))
      assert.equal(ligne.endsAt.getTime(), OPEN_ENDED_BOOKING_END.getTime())
      assert.ok(isOpenEndedBooking(ligne))

      const [rows] = (await asTenant((tx) =>
        tx.execute(sql`select booking_open_end() as fin`),
      )) as unknown as [{ fin: Date }[]]
      assert.equal(instant(rows[0].fin).getTime(), OPEN_ENDED_BOOKING_END.getTime())

      assert.equal(
        await errorCode(() => reserver('2031-05-12 08:00:00', '2031-05-12 09:00:00')),
        DB_EXCLUSION_VIOLATION,
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
      assert.equal(await count(sql`select count(*) as n from bookings where contract_id = ${id}`), 1)
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
        await errorCode(() => reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00')),
        DB_EXCLUSION_VIOLATION,
      )
      // Le dernier jour compte en entier : 23h00 le 30 juin, heure de Paris.
      assert.equal(
        await errorCode(() => reserver('2026-06-30 21:00:00', '2026-06-30 21:30:00')),
        DB_EXCLUSION_VIOLATION,
      )
    })

    it('accepte une réservation horaire dès le lendemain du terme', async () => {
      await activer(await contrat())
      // 1er juillet, 00h00 à 01h00 à Paris : bornes [) jointives.
      await reserver('2026-06-30 22:00:00', '2026-06-30 23:00:00')
      // Et sur une autre ressource pendant le contrat.
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00', AUTRE_BUREAU)
    })

    it('refuse un second contrat actif sur la même ressource', async () => {
      await activer(await contrat())
      const second = await contrat({
        reference: 'BUR-2026-002',
        clientId: AUTRE_CLIENT,
        startsOn: '2026-05-01',
        endsOn: null,
      })

      assert.equal(await errorCode(() => activer(second)), DB_EXCLUSION_VIOLATION)
      // L'activation échoue entière : le contrat reste un brouillon.
      const [rows] = (await asTenant((tx) =>
        tx.execute(sql`select status from contracts where id = ${second}`),
      )) as unknown as [{ status: string }[]]
      assert.equal(rows[0].status, 'draft')
      assert.equal(await occupation(second), undefined)
    })

    it('refuse l’activation sur un créneau déjà réservé à l’heure', async () => {
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00')
      const id = await contrat()
      assert.equal(await errorCode(() => activer(id)), DB_EXCLUSION_VIOLATION)
    })

    it('départage deux activations concurrentes sur la même ressource', async () => {
      const premier = await contrat()
      const second = await contrat({ reference: 'BUR-2026-002', clientId: AUTRE_CLIENT })
      const resultats = await Promise.allSettled([activer(premier), activer(second)])

      assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(await count(sql`select count(*) as n from bookings where kind = 'contract'`), 1)
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
        await errorCode(() => reserver('2026-04-15 15:00:00', '2026-04-15 16:00:00')),
        DB_EXCLUSION_VIOLATION,
      )
      await reserver('2026-04-16 07:00:00', '2026-04-16 08:00:00')
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
      await asTenant((tx) =>
        tx.execute(sql`update contracts set deleted_at = current_timestamp(3) where id = ${id}`),
      )

      const ligne = await occupation(id)
      assert.equal(ligne.status, 'cancelled')
      assert.ok(ligne.cancelledAt)
      assert.equal(ligne.cancellationReason, 'Contrat archivé')
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00')
    })

    it('le désarchivage rétablit l’occupation', async () => {
      const id = await contrat()
      await activer(id)
      await asTenant((tx) =>
        tx.execute(sql`update contracts set deleted_at = current_timestamp(3) where id = ${id}`),
      )
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
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00', BUREAU)
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
      await reserver('2026-03-10 08:00:00', '2026-03-10 09:00:00')
    })
  })

  describe('l’occupation ne s’écrit qu’à travers son contrat', () => {
    it('refuse de l’annuler, la déplacer, la modifier ou l’effacer directement', async () => {
      const id = await contrat()
      await activer(id)
      const ecritures = [
        sql`update bookings set status = 'cancelled', cancelled_at = current_timestamp(3) where contract_id = ${id}`,
        sql`update bookings set starts_at = starts_at + interval 1 day where contract_id = ${id}`,
        sql`update bookings set client_id = null where contract_id = ${id}`,
        sql`delete from bookings where contract_id = ${id}`,
      ]
      for (const ecriture of ecritures) {
        assert.equal(
          await errorCode(() => asTenant((tx) => tx.execute(ecriture))),
          DB_CONTRACT_OCCUPATION_LOCKED,
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
            values (${AUTRE_BUREAU}, ${id}, 'contract', 'staff', '2026-04-01 00:00:00', '2026-05-01 00:00:00', 'Fausse')
          `),
        ),
      )
      assert.equal(code, DB_CONTRACT_OCCUPATION_LOCKED)
    })

    it('refuse de transformer une réservation en occupation', async () => {
      await reserver('2026-04-10 07:00:00', '2026-04-10 08:00:00')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update bookings set kind = 'contract'`)),
      )
      assert.equal(code, DB_CONTRACT_OCCUPATION_LOCKED)
    })

    it('laisse les autres réservations s’annuler normalement', async () => {
      await activer(await contrat())
      await reserver('2026-07-02 07:00:00', '2026-07-02 08:00:00')
      await asTenant((tx) =>
        tx.execute(sql`
          update bookings set status = 'cancelled', cancelled_at = current_timestamp(3) where kind = 'booking'`),
      )
    })
  })

  describe('rattachement d’une réservation à un contrat (R05)', () => {
    it('accepte une réservation horaire rattachée à un contrat du centre', async () => {
      const id = await contrat({ resourceId: null })
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, contract_id, client_id, channel, starts_at, ends_at, title)
          values (${BUREAU}, ${id}, ${CLIENT}, 'staff', '2026-04-10 07:00:00', '2026-04-10 08:00:00', 'Réunion incluse')
        `),
      )
      assert.equal(
        await count(sql`select count(*) as n from bookings where contract_id = ${id} and kind = 'booking'`),
        1,
      )
    })

    it('refuse le contrat d’un autre centre', async () => {
      const id = await contrat({ resourceId: null })
      await bases.owner.client.query('insert into tenants (id, name, slug) values (?, ?, ?)', [
        AUTRE_CENTRE,
        'Autre centre',
        'autre-centre-occ',
      ])
      const code = await errorCode(() =>
        asTenant(async (tx) => {
          await tx.execute(sql`
            insert into resources (id, tenant_id, resource_type, code, name)
            values (${SALLE_AILLEURS}, ${AUTRE_CENTRE}, 'salle', 'X-1', 'Salle ailleurs')`)
          await tx.execute(sql`
            insert into bookings (tenant_id, resource_id, contract_id, channel, starts_at, ends_at, title)
            values (${AUTRE_CENTRE}, ${SALLE_AILLEURS}, ${id}, 'staff', '2026-04-10 07:00:00',
                    '2026-04-10 08:00:00', 'Fuite')`)
        }, AUTRE_CENTRE),
      )
      assert.equal(code, DB_FOREIGN_KEY_VIOLATION)
    })

    it('exige un contrat sur toute occupation', async () => {
      // Même le chemin de la routine ne peut pas poser une occupation
      // orpheline : la contrainte `check` tient après le garde.
      const code = await errorCode(() =>
        bases.owner.db.transaction(async (tx) => {
          await tx.execute(sql`set @app_contract_occupation_sync = 'on'`)
          try {
            await tx.execute(sql`
              insert into bookings (tenant_id, resource_id, kind, channel, starts_at, ends_at, title)
              values (${DEFAULT_TENANT_ID}, ${BUREAU}, 'contract', 'staff', '2026-04-01 00:00:00',
                      '2026-05-01 00:00:00', 'Orpheline')`)
          } finally {
            // La connexion retourne au pool : le drapeau ne doit pas la suivre.
            await tx.execute(sql`set @app_contract_occupation_sync = null`)
          }
        }),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })
  })

  describe('reprise des contrats existants', () => {
    /** Retire les occupations de contrat, comme si elles n'avaient jamais été posées. */
    const retirerLesOccupations = async () => {
      const connection = await bases.owner.client.getConnection()
      try {
        await connection.query("set @app_contract_occupation_sync = 'on'")
        await connection.query("delete from bookings where kind = 'contract'")
      } finally {
        await connection.query('set @app_contract_occupation_sync = null')
        connection.release()
      }
    }

    /** Un contrat tel qu'il serait avant l'occupation : actif, sans occupation. */
    const contratAnterieur = async (values: Parameters<typeof contrat>[0]) => {
      const id = await contrat(values)
      await retirerLesOccupations()
      return id
    }

    /** `call backfill_contract_occupations(@n)`, sur une seule connexion. */
    const reprendre = async (): Promise<number> => {
      const connection = await bases.owner.client.getConnection()
      try {
        await connection.query('set @app_tenant_id = ?', [DEFAULT_TENANT_ID])
        await connection.query('call backfill_contract_occupations(@skipped)')
        const [rows] = (await connection.query('select @skipped as skipped')) as unknown as [
          { skipped: number }[],
        ]
        return Number(rows[0].skipped)
      } finally {
        await connection.query('set @app_tenant_id = null')
        connection.release()
      }
    }

    it('pose l’occupation des contrats actifs et résiliés', async () => {
      const actif = await contratAnterieur({ status: 'active', endsOn: null })
      const resilie = await contratAnterieur({
        reference: 'BUR-2025-001',
        resourceId: AUTRE_BUREAU,
        startsOn: '2025-01-01',
        endsOn: null,
        status: 'active',
      })
      await asTenant((tx) =>
        tx.execute(sql`
          update contracts set status = 'terminated', terminated_on = '2025-06-30' where id = ${resilie}`),
      )
      await retirerLesOccupations()
      await contrat({ reference: 'BUR-2026-009', resourceId: AUTRE_BUREAU, status: 'draft' })

      assert.equal(await reprendre(), 0)
      assert.equal((await occupation(actif)).status, 'confirmed')
      assert.equal((await occupation(resilie)).endsAt.toISOString(), '2025-06-30T22:00:00.000Z')
      assert.equal(await count(sql`select count(*) as n from bookings where kind = 'contract'`), 2)
    })

    it('signale un chevauchement au lieu d’échouer, puis se rejoue une fois résolu', async () => {
      await contratAnterieur({ status: 'active', startsOn: '2026-01-01', endsOn: null })
      const second = await contratAnterieur({
        reference: 'BUR-2026-002',
        clientId: AUTRE_CLIENT,
        status: 'active',
        startsOn: '2026-05-01',
        endsOn: null,
      })

      assert.equal(await reprendre(), 1)
      assert.equal(await occupation(second), undefined)

      // L'équipe tranche : le second contrat passe sur l'autre bureau.
      await asTenant((tx) =>
        tx.execute(sql`update contracts set resource_id = ${AUTRE_BUREAU} where id = ${second}`),
      )
      assert.equal(await reprendre(), 0)
      assert.equal((await occupation(second)).resourceId, AUTRE_BUREAU)
    })
  })
})
