import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, asc, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_AMENDMENT_INVALID,
  PG_CHECK_VIOLATION,
  PG_COMMITMENT_LOCKED,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { bookings, OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'
import { contractAmendments, contractDocuments, contractLines, contracts } from './schema.ts'

/**
 * Contrats versionnés (R12, ADR 025, amende les ADR 006 et 018) : lignes,
 * avenants, segments d'occupation, documents figés, et souscriptions (R18).
 *
 * Un contrat engagé ne se réécrit pas : son prix change par avenant, à une
 * date d'effet. Un avenant qui change la ressource en cours de contrat garde
 * l'occupation exacte — l'ancienne ressource jusqu'à la veille, la nouvelle
 * ensuite — sous la même contrainte d'exclusion (décision 3). Les cas de
 * l'ADR 018 sans avenant restent éprouvés par `occupation.db.test.ts`.
 *
 * Tout est éprouvé sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('contrats versionnés', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const CLIENT = '01a00000-0000-7000-8000-0000000a0c01'
  const AUTRE_CLIENT = '01a00000-0000-7000-8000-0000000a0c02'
  const BUREAU = '01a00000-0000-7000-8000-0000000a0b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000a0b02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000a0d01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Contrat de bureau du 1er mars 2026, sans terme, en brouillon par défaut. */
  const contrat = async (values: Partial<typeof contracts.$inferInsert> = {}): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx
        .insert(contracts)
        .values({
          clientId: CLIENT,
          reference: 'BUR-2026-010',
          contractType: 'bureau',
          startsOn: '2026-03-01',
          amountCents: 90_000,
          resourceId: BUREAU,
          ...values,
        })
        .returning({ id: contracts.id }),
    )
    return row.id
  }

  const activer = (id: string) =>
    asTenant((tx) => tx.update(contracts).set({ status: 'active' }).where(eq(contracts.id, id)))

  const lire = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(contracts).where(eq(contracts.id, id)))
    return row
  }

  const ligne = (contractId: string, values: Partial<typeof contractLines.$inferInsert> = {}) =>
    asTenant(async (tx) => {
      const [row] = await tx
        .insert(contractLines)
        .values({ contractId, description: 'Bureau équipé', unitPriceCents: 90_000, ...values })
        .returning()
      return row
    })

  const avenant = (contractId: string, values: Partial<typeof contractAmendments.$inferInsert> = {}) =>
    asTenant(async (tx) => {
      const [row] = await tx
        .insert(contractAmendments)
        .values({ contractId, effectiveOn: '2026-05-01', ...values })
        .returning()
      return row
    })

  const signer = (id: string) =>
    asTenant((tx) =>
      tx.update(contractAmendments).set({ status: 'signed' }).where(eq(contractAmendments.id, id)),
    )

  /** Occupations d'un contrat, du premier segment au dernier. */
  const occupations = (contractId: string) =>
    asTenant((tx) =>
      tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.contractId, contractId), eq(bookings.kind, 'contract')))
        .orderBy(asc(bookings.startsAt)),
    )

  const reserver = (start: string, end: string, resourceId = BUREAU) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, channel, starts_at, ends_at, title)
        values (${resourceId}, 'staff', ${start}, ${end}, 'Rendez-vous')`),
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name) values (${CLIENT}, 'Acme SAS'), (${AUTRE_CLIENT}, 'Beta SARL')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'BUR-A1', 'Bureau 1'),
          (${AUTRE_BUREAU}, 'bureau', 'BUR-A2', 'Bureau 2')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('lignes et prix d’un contrat', () => {
    it('tient le montant du brouillon égal à ses lignes récurrentes', async () => {
      const id = await contrat({ amountCents: 0 })
      await ligne(id, { unitPriceCents: 80_000 })
      const poste = await ligne(id, {
        description: 'Poste supplémentaire',
        resourceId: null,
        resourceType: 'bureau',
        quantity: 2,
        unitPriceCents: 15_000,
        discountBp: 1_000,
      })
      await ligne(id, { description: 'Frais de dossier', unitPriceCents: 5_000, isRecurring: false })
      assert.equal(poste.netAmountCents, 27_000)
      assert.equal((await lire(id)).amountCents, 107_000)

      // Le montant écrit par le code est ignoré : les lignes le tiennent.
      await asTenant((tx) => tx.update(contracts).set({ amountCents: 1 }).where(eq(contracts.id, id)))
      assert.equal((await lire(id)).amountCents, 107_000)

      await asTenant((tx) =>
        tx.update(contractLines).set({ deletedAt: new Date() }).where(eq(contractLines.id, poste.id)),
      )
      assert.equal((await lire(id)).amountCents, 80_000)
    })

    it('fige le prix et les lignes d’un contrat engagé : ils changent par avenant', async () => {
      const id = await contrat()
      const premiere = await ligne(id)
      await activer(id)
      const tentatives = [
        () => ligne(id, { description: 'Ajout' }),
        () =>
          asTenant((tx) =>
            tx.update(contractLines).set({ unitPriceCents: 1 }).where(eq(contractLines.id, premiere.id)),
          ),
        () => asTenant((tx) => tx.update(contracts).set({ amountCents: 1 }).where(eq(contracts.id, id))),
        () => asTenant((tx) => tx.update(contracts).set({ vatRateBp: 1_000 }).where(eq(contracts.id, id))),
        () => asTenant((tx) => tx.update(contracts).set({ commitmentMonths: 12 }).where(eq(contracts.id, id))),
      ]
      for (const tentative of tentatives) assert.equal(await errorCode(tentative), PG_COMMITMENT_LOCKED)
      // Le reste se modifie comme avant (ADR 018).
      await asTenant((tx) => tx.update(contracts).set({ notes: 'Clés remises' }).where(eq(contracts.id, id)))
      assert.equal(
        await errorCode(() => asTenant((tx) => tx.delete(contractLines).where(eq(contractLines.id, premiere.id)))),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('calcule la fin d’engagement et le premier terme possible d’un préavis', async () => {
      const id = await contrat({ startsOn: '2026-03-10', commitmentMonths: 12, noticeDays: 90 })
      assert.equal((await lire(id)).commitmentEndsOn, '2027-03-09')
      assert.equal((await lire(await contrat({ reference: 'SANS-ENGAGEMENT' }))).commitmentEndsOn, null)

      const terme = (noticeOn: string) =>
        asTenant(async (tx) => {
          const [row] = await tx.execute(
            sql`select contract_earliest_end_on(${id}::uuid, ${noticeOn}::date)::text as terme`,
          )
          return row.terme
        })
      // Préavis donné pendant l'engagement : le terme est la fin de l'engagement.
      assert.equal(await terme('2026-04-01'), '2027-03-09')
      // Après : 90 jours, jour de la demande compris.
      assert.equal(await terme('2027-03-01'), '2027-05-29')
    })

    it('exige une reconduction tacite complète', async () => {
      assert.equal(await errorCode(() => contrat({ tacitRenewal: true })), PG_CHECK_VIOLATION)
      await contrat({ tacitRenewal: true, renewalMonths: 12, endsOn: '2027-02-28' })
    })
  })

  describe('avenants', () => {
    it('ne s’établissent que sur un contrat en cours, numérotés par contrat', async () => {
      const id = await contrat()
      assert.equal(await errorCode(() => avenant(id)), PG_AMENDMENT_INVALID)
      await activer(id)
      assert.equal((await avenant(id)).number, 1)
      assert.equal((await avenant(id, { effectiveOn: '2026-06-01' })).number, 2)
      const autre = await contrat({ reference: 'BUR-2026-011', resourceId: AUTRE_BUREAU })
      await activer(autre)
      assert.equal((await avenant(autre)).number, 1)
    })

    it('refusent une date d’effet hors de la période, ou qui ne suit pas le dernier avenant signé', async () => {
      const id = await contrat({ endsOn: '2026-12-31' })
      await activer(id)
      const prix = { amountCents: 95_000 }
      for (const effectiveOn of ['2026-03-01', '2026-02-01', '2027-01-01']) {
        const brouillon = await avenant(id, { effectiveOn, ...prix })
        assert.equal(await errorCode(() => signer(brouillon.id)), PG_AMENDMENT_INVALID, effectiveOn)
      }
      await signer((await avenant(id, { effectiveOn: '2026-06-01', ...prix })).id)
      const anterieur = await avenant(id, { effectiveOn: '2026-05-01', ...prix })
      assert.equal(await errorCode(() => signer(anterieur.id)), PG_AMENDMENT_INVALID)
      // Un avenant qui ne change rien ne se signe pas.
      const vide = await avenant(id, { effectiveOn: '2026-09-01' })
      assert.equal(await errorCode(() => signer(vide.id)), PG_AMENDMENT_INVALID)
    })

    it('signé, ne change plus, ni ses lignes ; il fige la date de début du contrat', async () => {
      const id = await contrat()
      await activer(id)
      const brouillon = await avenant(id)
      const nouvelleLigne = await ligne(id, { amendmentId: brouillon.id, unitPriceCents: 95_000 })
      const [prepare] = await asTenant((tx) =>
        tx.select().from(contractAmendments).where(eq(contractAmendments.id, brouillon.id)),
      )
      // Le montant de l'avenant suit ses lignes.
      assert.equal(prepare.amountCents, 95_000)
      await signer(brouillon.id)

      const tentatives = [
        () =>
          asTenant((tx) =>
            tx.update(contractAmendments).set({ effectiveOn: '2026-06-01' }).where(eq(contractAmendments.id, brouillon.id)),
          ),
        () =>
          asTenant((tx) =>
            tx.update(contractLines).set({ unitPriceCents: 1 }).where(eq(contractLines.id, nouvelleLigne.id)),
          ),
        () => ligne(id, { amendmentId: brouillon.id }),
        () => asTenant((tx) => tx.update(contracts).set({ startsOn: '2026-02-01' }).where(eq(contracts.id, id))),
      ]
      for (const tentative of tentatives) assert.equal(await errorCode(tentative), PG_COMMITMENT_LOCKED)
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.delete(contractAmendments).where(eq(contractAmendments.id, brouillon.id))),
        ),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('refusent un nouveau prix sur une période déjà facturée, pas un changement de ressource (ADR 032)', async () => {
      const id = await contrat()
      await activer(id)
      // Mai facturé au loyer du contrat, sur un brouillon de facture.
      const [facture] = await asTenant((tx) =>
        tx.execute(sql`
          insert into invoices (client_id, period_start, period_end)
          values (${CLIENT}, '2026-05-01', '2026-05-31') returning id`),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into invoice_lines (invoice_id, kind, description, contract_id, period_start, period_end,
                                     unit_price_cents, vat_rate_bp)
          values (${facture.id as string}, 'rent', 'Loyer de mai', ${id}, '2026-05-01', '2026-05-31', 90000, 2000)`),
      )
      const factureJusquAu = async () => {
        const [row] = await asTenant((tx) =>
          tx.execute(sql`select contract_billed_through(${id}::uuid)::text as jour`),
        )
        return row.jour
      }
      assert.equal(await factureJusquAu(), '2026-05-31')

      // Un changement de ressource seule ne change pas ce qui est dû.
      await signer((await avenant(id, { effectiveOn: '2026-05-10', changesResource: true, resourceId: AUTRE_BUREAU })).id)

      // Un nouveau prix au 15 mai ferait facturer deux fois la fin du mois.
      const hausse = await avenant(id, { effectiveOn: '2026-05-15', amountCents: 95_000 })
      let message = ''
      try {
        await signer(hausse.id)
      } catch (error) {
        assert.equal(pgErrorCode(error), PG_AMENDMENT_INVALID)
        for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
          message += String((cause as { message?: unknown }).message ?? '')
        }
      }
      assert.match(message, /facturé jusqu.au 31\/05\/2026.*au plus tôt le 01\/06\/2026/)

      // La ligne retirée du brouillon ne tient plus la période : l'avenant se signe.
      await asTenant((tx) =>
        tx.execute(sql`update invoices set deleted_at = now() where id = ${facture.id as string}`),
      )
      assert.equal(await factureJusquAu(), null)
      await signer(hausse.id)
    })

    it('donnent les versions de prix du contrat, chacune de sa date d’effet à la veille de la suivante', async () => {
      const id = await contrat({ endsOn: '2026-12-31' })
      await ligne(id, { unitPriceCents: 90_000 })
      await activer(id)
      const hausse = await avenant(id, { effectiveOn: '2026-07-01', reason: 'Indexation' })
      await ligne(id, { amendmentId: hausse.id, unitPriceCents: 92_000 })
      await signer(hausse.id)
      // Un avenant de ressource seule ne crée pas de version de prix.
      await signer((await avenant(id, { effectiveOn: '2026-09-01', changesResource: true, resourceId: AUTRE_BUREAU })).id)

      const versions = await asTenant((tx) =>
        tx.execute(sql`
          select amendment_id, amendment_number, starts_on::text, ends_on::text, amount_cents
            from contract_price_versions(${id}::uuid)`),
      )
      assert.deepEqual(
        versions.map((v) => [v.amendment_number, v.starts_on, v.ends_on, v.amount_cents]),
        [
          [null, '2026-03-01', '2026-06-30', 90_000],
          [1, '2026-07-01', '2026-12-31', 92_000],
        ],
      )
      assert.equal(versions[1].amendment_id, hausse.id)
    })
  })

  describe('occupation par segments lors d’un changement de ressource', () => {
    /** Contrat actif sur le bureau 1 depuis le 1er mars, sans terme. */
    const contratActif = async (values: Partial<typeof contracts.$inferInsert> = {}) => {
      const id = await contrat({ endsOn: null, ...values })
      await activer(id)
      return id
    }
    const demenager = async (id: string, effectiveOn = '2026-05-01', resourceId: string | null = AUTRE_BUREAU) => {
      const brouillon = await avenant(id, { effectiveOn, changesResource: true, resourceId })
      await signer(brouillon.id)
      return brouillon
    }

    it('occupe l’ancienne ressource jusqu’à la veille, la nouvelle ensuite', async () => {
      const id = await contratActif()
      const signe = await demenager(id)

      const [ancien, nouveau] = await occupations(id)
      assert.equal(ancien.resourceId, BUREAU)
      assert.equal(ancien.contractAmendmentId, null)
      assert.equal(ancien.title, 'Contrat BUR-2026-010')
      assert.equal(ancien.startsAt.toISOString(), '2026-02-28T23:00:00.000Z')
      // Le 30 avril compris, jusqu'à minuit heure de Paris (été).
      assert.equal(ancien.endsAt.toISOString(), '2026-04-30T22:00:00.000Z')
      assert.equal(nouveau.resourceId, AUTRE_BUREAU)
      assert.equal(nouveau.contractAmendmentId, signe.id)
      assert.equal(nouveau.title, 'Contrat BUR-2026-010 — avenant n° 1')
      assert.equal(nouveau.startsAt.toISOString(), '2026-04-30T22:00:00.000Z')
      assert.equal(nouveau.endsAt.getTime(), OPEN_ENDED_BOOKING_END.getTime())
      for (const segment of [ancien, nouveau]) {
        assert.equal(segment.status, 'confirmed')
        assert.equal(segment.clientId, CLIENT)
      }

      // L'ancien bureau est libre dès la date d'effet, occupé avant ; le
      // nouveau est occupé dès la date d'effet.
      await reserver('2026-05-10T08:00:00Z', '2026-05-10T09:00:00Z', BUREAU)
      assert.equal(
        await errorCode(() => reserver('2026-04-20T08:00:00Z', '2026-04-20T09:00:00Z', BUREAU)),
        PG_EXCLUSION_VIOLATION,
      )
      assert.equal(
        await errorCode(() => reserver('2026-05-10T08:00:00Z', '2026-05-10T09:00:00Z', AUTRE_BUREAU)),
        PG_EXCLUSION_VIOLATION,
      )
      await reserver('2026-04-20T08:00:00Z', '2026-04-20T09:00:00Z', AUTRE_BUREAU)
    })

    it('refuse la signature si la nouvelle ressource est prise, sans rien changer', async () => {
      const id = await contratActif()
      await reserver('2026-06-10T08:00:00Z', '2026-06-10T09:00:00Z', AUTRE_BUREAU)
      const brouillon = await avenant(id, { changesResource: true, resourceId: AUTRE_BUREAU })
      assert.equal(await errorCode(() => signer(brouillon.id)), PG_EXCLUSION_VIOLATION)

      const [seul, ...reste] = await occupations(id)
      assert.deepEqual(reste, [])
      assert.equal(seul.resourceId, BUREAU)
      assert.equal(seul.endsAt.getTime(), OPEN_ENDED_BOOKING_END.getTime())
      const [encore] = await asTenant((tx) =>
        tx.select().from(contractAmendments).where(eq(contractAmendments.id, brouillon.id)),
      )
      assert.equal(encore.status, 'draft')
    })

    it('raccourcit le dernier segment à la résiliation', async () => {
      const id = await contratActif()
      await demenager(id)
      await asTenant((tx) =>
        tx.update(contracts).set({ status: 'terminated', terminatedOn: '2026-06-15' }).where(eq(contracts.id, id)),
      )
      const [ancien, nouveau] = await occupations(id)
      assert.equal(ancien.endsAt.toISOString(), '2026-04-30T22:00:00.000Z')
      assert.equal(nouveau.endsAt.toISOString(), '2026-06-15T22:00:00.000Z')
    })

    it('annule le segment d’un avenant quand la résiliation le précède', async () => {
      const id = await contratActif()
      await demenager(id)
      await asTenant((tx) =>
        tx.update(contracts).set({ status: 'terminated', terminatedOn: '2026-04-15' }).where(eq(contracts.id, id)),
      )
      const [ancien, nouveau] = await occupations(id)
      assert.equal(ancien.status, 'confirmed')
      assert.equal(ancien.endsAt.toISOString(), '2026-04-15T22:00:00.000Z')
      assert.equal(nouveau.status, 'cancelled')
      assert.equal(nouveau.cancellationReason, "Contrat résilié avant la date d'effet de l'avenant")
    })

    it('annule tous les segments à l’archivage, et les rétablit au désarchivage', async () => {
      const id = await contratActif()
      await demenager(id)
      await asTenant((tx) => tx.update(contracts).set({ deletedAt: new Date() }).where(eq(contracts.id, id)))
      for (const segment of await occupations(id)) {
        assert.equal(segment.status, 'cancelled')
        assert.equal(segment.cancellationReason, 'Contrat archivé')
      }
      await asTenant((tx) => tx.update(contracts).set({ deletedAt: null }).where(eq(contracts.id, id)))
      const retablis = await occupations(id)
      assert.deepEqual(
        retablis.map((segment) => [segment.resourceId, segment.status]),
        [
          [BUREAU, 'confirmed'],
          [AUTRE_BUREAU, 'confirmed'],
        ],
      )
    })

    it('libère la ressource quand l’avenant la retire', async () => {
      const id = await contratActif()
      await demenager(id, '2026-05-01', null)
      const [seul, ...reste] = await occupations(id)
      assert.deepEqual(reste, [])
      assert.equal(seul.resourceId, BUREAU)
      assert.equal(seul.endsAt.toISOString(), '2026-04-30T22:00:00.000Z')
    })

    it('enchaîne plusieurs avenants, y compris un retour sur la première ressource', async () => {
      const id = await contratActif()
      await demenager(id, '2026-05-01', AUTRE_BUREAU)
      await demenager(id, '2026-07-01', BUREAU)
      assert.deepEqual(
        (await occupations(id)).map((segment) => [
          segment.resourceId,
          segment.startsAt.toISOString(),
          segment.endsAt.toISOString(),
        ]),
        [
          [BUREAU, '2026-02-28T23:00:00.000Z', '2026-04-30T22:00:00.000Z'],
          [AUTRE_BUREAU, '2026-04-30T22:00:00.000Z', '2026-06-30T22:00:00.000Z'],
          [BUREAU, '2026-06-30T22:00:00.000Z', OPEN_ENDED_BOOKING_END.toISOString()],
        ],
      )
    })

    it('garde une seule occupation à un contrat sans avenant de ressource (ADR 018)', async () => {
      const id = await contratActif()
      await signer((await avenant(id, { amountCents: 95_000 })).id)
      await asTenant((tx) => tx.update(contracts).set({ notes: 'Indexé' }).where(eq(contracts.id, id)))
      assert.equal((await occupations(id)).length, 1)
    })
  })

  describe('documents de contrat', () => {
    it('versionnent chaque document et en calculent l’empreinte en base', async () => {
      const id = await contrat()
      const snapshot = { reference: 'BUR-2026-010', client: { name: 'Acme SAS' }, montant: 90_000 }
      const ecrire = () =>
        asTenant(async (tx) => {
          const [row] = await tx
            .insert(contractDocuments)
            .values({ contractId: id, snapshot, generatedBy: ACCUEIL })
            .returning()
          return row
        })
      const premier = await ecrire()
      const second = await ecrire()
      assert.equal(premier.version, 1)
      assert.equal(second.version, 2)

      const [canonique] = await asTenant((tx) =>
        tx.execute(sql`select snapshot::text as texte from contract_documents where id = ${premier.id}`),
      )
      const attendu = createHash('sha256').update(String(canonique.texte), 'utf8').digest('hex')
      assert.equal(premier.sha256, attendu)
    })

    it('ne se réécrivent pas', async () => {
      const id = await contrat()
      const [document] = await asTenant((tx) =>
        tx.insert(contractDocuments).values({ contractId: id, snapshot: { v: 1 } }).returning(),
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.update(contractDocuments).set({ snapshot: { v: 2 } }).where(eq(contractDocuments.id, document.id)),
          ),
        ),
        PG_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await errorCode(() => owner.client`update contract_documents set snapshot = '{"v": 2}' where id = ${document.id}`),
        PG_COMMITMENT_LOCKED,
      )
    })
  })

  describe('services souscrits (R18)', () => {
    const souscrire = (values: Record<string, unknown> = {}) =>
      asTenant(async (tx) => {
        const [service] = await tx.execute(sql`select id from services where name = 'Standard'`)
        const serviceId =
          (service?.id as string | undefined) ??
          ((
            await tx.execute(sql`
              insert into services (name, nature, unit, unit_price_cents)
              values ('Standard', 'package', 'month', 5000) returning id`)
          )[0].id as string)
        const v = {
          clientId: CLIENT,
          contractId: null as string | null,
          startsOn: '2026-01-01',
          endsOn: null as string | null,
          ...values,
        }
        const [row] = await tx.execute(sql`
          insert into subscribed_services (client_id, contract_id, service_id, unit, unit_price_cents, vat_rate_bp,
                                           starts_on, ends_on)
          values (${v.clientId}, ${v.contractId}, ${serviceId}, 'month', 5000, 2000, ${v.startsOn}, ${v.endsOn})
          returning id`)
        return row.id as string
      })

    it('refusent une seconde souscription au même service sur une période qui recouvre la première', async () => {
      await souscrire({ endsOn: '2026-06-30' })
      assert.equal(await errorCode(() => souscrire({ startsOn: '2026-06-30' })), PG_EXCLUSION_VIOLATION)
      await souscrire({ startsOn: '2026-07-01' })
      // Pour un autre client, rien ne bloque.
      await souscrire({ clientId: AUTRE_CLIENT })
    })

    it('ne se réécrivent pas, mais prennent fin', async () => {
      const id = await souscrire()
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.execute(sql`update subscribed_services set unit_price_cents = 1 where id = ${id}`)),
        ),
        PG_COMMITMENT_LOCKED,
      )
      await asTenant((tx) =>
        tx.execute(sql`update subscribed_services set ends_on = '2026-12-31' where id = ${id}`),
      )
    })

    it('ne se rattachent qu’à un contrat du même client', async () => {
      const contratAutre = await contrat({ clientId: AUTRE_CLIENT, resourceId: null })
      assert.equal(
        await errorCode(() => souscrire({ contractId: contratAutre })),
        PG_FOREIGN_KEY_VIOLATION,
      )
      await souscrire({ contractId: await contrat({ reference: 'DOM-1', resourceId: null }) })
    })
  })
})
