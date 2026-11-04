import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_EXCLUSION_VIOLATION, DB_INSPECTION_INVALID, dbErrorCode, dbSignalMessage } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { BookingConflictError, createBooking } from '../reservations/queries.ts'
import { InspectionRefusal } from './erreurs.ts'
import { groupByOccupation } from './occupations.ts'
import {
  createInspection,
  findInspection,
  listOccupationCandidates,
  listResourceTimeline,
  saveInspection,
  withdrawInspection,
  type CandidateContext,
} from './queries.ts'
import { listUnreturnedOccupations } from './restitution.ts'

/**
 * Une entrée par occupation, et la ressource occupée jusqu'à sa sortie
 * (ADR 063), éprouvées contre la base : la garde des états des lieux
 * (`80-etats-des-lieux.sql`) et celle des réservations
 * (`booking_assert_resource_returned`, `85-restitution.sql`), appelée par le
 * trigger anti-chevauchement (décision 3). Les heures sont comptées depuis
 * l'horloge de la base, celle que lit le trigger.
 */
describe('états des lieux : une entrée par occupation, restitution', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-000000070c01'
  const PETIT = '01a00000-0000-7000-8000-000000070c02'
  const CAMILLE = '01a00000-0000-7000-8000-000000070e01'
  const UTILITAIRE = '01a00000-0000-7000-8000-000000070b01'
  const FOURGON = '01a00000-0000-7000-8000-000000070b02'
  const BUREAU = '01a00000-0000-7000-8000-000000070b03'
  const CONTRAT = '01a00000-0000-7000-8000-000000070f01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const lire = async (tx: Transaction, requete: ReturnType<typeof sql>) =>
    ((await tx.execute(requete)) as unknown as [Record<string, unknown>[]])[0]

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const refus = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await run()
    } catch (error) {
      if (error instanceof InspectionRefusal) return error.message
      throw error
    }
    return undefined
  }

  /** Réservation, bornes en heures depuis maintenant (horloge de la base). */
  const reservation = async (
    debut: number,
    fin: number,
    { resource = UTILITAIRE, client = DURAND as string | null, status = 'confirmed', titre = 'Location' } = {},
  ) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${id}, ${resource}, ${client}, 'booking', 'staff', ${status}, ${titre},
                date_add(CURRENT_TIMESTAMP(3), interval ${Math.round(debut * 60)} minute),
                date_add(CURRENT_TIMESTAMP(3), interval ${Math.round(fin * 60)} minute))`),
    )
    return id
  }

  /** Occupation du contrat sur le bureau, écrite comme la routine des contrats l'écrit. */
  const occupationDeContrat = async (debutJours: number, finJours: number) => {
    const id = uuidv7()
    await bases.owner.db.transaction(async (tx) => {
      await tx.execute(sql`set @app_contract_occupation_sync = 'on'`)
      try {
        await tx.execute(sql`
          insert into bookings (id, tenant_id, resource_id, client_id, contract_id, kind, channel, status, title,
                                starts_at, ends_at)
          values (${id}, ${DEFAULT_TENANT_ID}, ${BUREAU}, ${DURAND}, ${CONTRAT}, 'contract', 'staff', 'confirmed',
                  'Contrat EDL-7', date_add(CURRENT_TIMESTAMP(3), interval ${debutJours} day),
                  date_add(CURRENT_TIMESTAMP(3), interval ${finJours} day))`)
      } finally {
        await tx.execute(sql`set @app_contract_occupation_sync = null`)
      }
    })
    return id
  }

  const decaler = (id: string, debut: number, fin: number) =>
    asTenant((tx) =>
      tx.execute(sql`
        update bookings
           set starts_at = date_add(CURRENT_TIMESTAMP(3), interval ${Math.round(debut * 60)} minute),
               ends_at = date_add(CURRENT_TIMESTAMP(3), interval ${Math.round(fin * 60)} minute)
         where id = ${id}`),
    )

  const ouvrir = (
    kind: 'entry' | 'exit',
    context: CandidateContext,
    candidateKey = context.kind === 'booking' ? `b:${context.id}` : '',
    performedAt = new Date(Date.now() - 60_000),
  ) => createInspection({ context, candidateKey, kind, entryInspectionId: null, performedAt }, CAMILLE)

  /** `ilYa` : heures écoulées depuis l'état des lieux, sur place. */
  const entree = (booking: string, ilYa = 0) =>
    ouvrir('entry', { kind: 'booking', id: booking }, undefined, new Date(Date.now() - (ilYa * 60 + 1) * 60_000))
  const sortie = (booking: string, ilYa = 0) =>
    ouvrir('exit', { kind: 'booking', id: booking }, undefined, new Date(Date.now() - (ilYa * 60 + 1) * 60_000))

  const clore = (id: string) =>
    saveInspection(id, { values: {}, observations: null, performedAt: new Date(Date.now() - 60_000) }, CAMILLE)

  const progression = async (booking: string) =>
    (await listOccupationCandidates({ kind: 'booking', id: booking }))[0]?.progress.step

  const toutVider = () =>
    viderTables(
      bases.owner,
      'inspection_photo_views',
      'inspection_photos',
      'inspections',
      'inspection_template_versions',
      'inspection_templates',
      'bookings',
      'contracts',
      'client_members',
      'clients',
      'resources',
      'staff_members',
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider()
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.test', 'Camille Martin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${UTILITAIRE}, 'vehicule', 'V-RES-1', 'Utilitaire'),
          (${FOURGON}, 'vehicule', 'V-RES-2', 'Fourgon'),
          (${BUREAU}, 'bureau', 'B-RES-1', 'Bureau 7')`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents, resource_id) values
          (${CONTRAT}, ${DURAND}, 'EDL-7', 'bureau', '2026-01-01', 90000, ${BUREAU})`)
      // Un modèle par type sans champ obligatoire : la clôture n'attend rien.
      for (const type of ['vehicule', 'bureau']) {
        const modele = uuidv7()
        await tx.execute(sql`
          insert into inspection_templates (id, resource_type, name) values (${modele}, ${type}, ${`Modèle ${type}`})`)
        await tx.execute(sql`
          insert into inspection_template_versions (id, template_id, version, name, fields, created_by)
          values (${uuidv7()}, ${modele}, 1, ${`Modèle ${type}`},
                  ${JSON.stringify([{ id: 'remarques', label: 'Remarques', type: 'text', required: false }])},
                  ${CAMILLE})`)
      }
    })
  })

  after(async () => {
    await toutVider()
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('une entrée par occupation', () => {
    it('refuse un second état des lieux d’entrée pour la même réservation, à l’écran comme en base', async () => {
      const location = await reservation(1, 5)
      const premiere = await entree(location)
      assert.equal(await progression(location), 'entry_draft')

      assert.match((await refus(() => entree(location))) ?? '', /déjà son état des lieux d’entrée, en saisie/)
      // La base, sans passer par le code.
      const [{ version }] = await asTenant((tx) =>
        lire(tx, sql`select template_version_id as version from inspections where id = ${premiere}`),
      )
      const brut = () =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into inspections (kind, resource_id, client_id, booking_id, template_version_id, created_by)
            values ('entry', ${UTILITAIRE}, ${DURAND}, ${location}, ${version as string}, ${CAMILLE})`),
        )
      assert.equal(await codeErreur(brut), DB_INSPECTION_INVALID)

      // Close, elle ne laisse que la sortie.
      await clore(premiere)
      assert.equal(await progression(location), 'entry_closed')
      assert.match((await refus(() => entree(location))) ?? '', /seule la sortie reste à faire/)
      assert.equal(await codeErreur(brut), DB_INSPECTION_INVALID)

      // Une autre réservation de la même ressource a la sienne.
      await entree(await reservation(30, 34))
    })

    it('rend la place quand le brouillon est retiré', async () => {
      const location = await reservation(1, 5)
      await withdrawInspection(await entree(location))
      assert.equal(await progression(location), 'none')
      const reprise = await entree(location)
      assert.equal((await findInspection(reprise))?.stage, 'draft')
    })

    it('ne laisse passer qu’une ouverture quand le formulaire part deux fois', async () => {
      const location = await reservation(1, 5)
      const essais = await Promise.allSettled([entree(location), entree(location), entree(location)])
      assert.equal(essais.filter((essai) => essai.status === 'fulfilled').length, 1)
      for (const essai of essais) {
        if (essai.status === 'rejected') assert.ok(essai.reason instanceof InspectionRefusal, String(essai.reason))
      }
    })

    it('compte l’entrée faite sur le contrat en brouillon pour l’occupation qui la suit', async () => {
      const premiere = await ouvrir('entry', { kind: 'contract', id: CONTRAT }, `c:${CONTRAT}:${BUREAU}`)
      const occupation = await occupationDeContrat(-1, 30)
      const [candidat] = await listOccupationCandidates({ kind: 'contract', id: CONTRAT })
      assert.equal(candidat.key, `b:${occupation}`)
      assert.equal(candidat.progress.step, 'entry_draft')
      assert.equal(candidat.entry?.id, premiere)

      const [{ version }] = await asTenant((tx) =>
        lire(tx, sql`select template_version_id as version from inspections where id = ${premiere}`),
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into inspections (kind, resource_id, client_id, booking_id, contract_id, template_version_id, created_by)
              values ('entry', ${BUREAU}, ${DURAND}, ${occupation}, ${CONTRAT}, ${version as string}, ${CAMILLE})`),
          ),
        ),
        DB_INSPECTION_INVALID,
      )
    })

    it('ferme la sortie sur l’entrée de l’occupation, puis plus rien ne s’ouvre', async () => {
      const location = await reservation(1, 5)
      const premiere = await entree(location)
      assert.match((await refus(() => sortie(location))) ?? '', /en saisie : terminez-la et close-la/)
      await clore(premiere)

      const fin = await sortie(location)
      assert.equal((await findInspection(fin))?.entryInspectionId, premiere)
      assert.equal(await progression(location), 'exit_draft')
      assert.match((await refus(() => sortie(location))) ?? '', /déjà son état des lieux de sortie/)
      await clore(fin)
      assert.equal(await progression(location), 'done')
      assert.match((await refus(() => entree(location))) ?? '', /seule la sortie reste à faire/)
    })
  })

  describe('ressource non restituée', () => {
    /** Location de l'utilitaire finie depuis une heure, entrée close, sortie à faire. */
    const enRetard = async () => {
      const location = await reservation(-5, -1)
      const premiere = await entree(location)
      await clore(premiere)
      return { location, premiere }
    }

    it('refuse une nouvelle réservation tant que la sortie n’est pas close, puis la laisse passer', async () => {
      const { location } = await enRetard()
      let message: string | undefined
      try {
        await reservation(24, 26)
      } catch (error) {
        assert.equal(dbErrorCode(error), DB_EXCLUSION_VIOLATION)
        message = dbSignalMessage(error)
      }
      assert.match(message ?? '', /^Ressource non restituée : « Utilitaire »/)

      // Ni une autre ressource, ni avant l'occupation.
      await reservation(24, 26, { resource: FOURGON })
      await reservation(-30, -28)

      // Une sortie en saisie ne rend pas la ressource ; close, si.
      const fin = await sortie(location)
      assert.equal(await codeErreur(() => reservation(24, 26)), DB_EXCLUSION_VIOLATION)
      await clore(fin)
      await reservation(24, 26)
    })

    it('laisse réserver la suite tant que la fin prévue n’est pas passée', async () => {
      const location = await reservation(-1, 2)
      await clore(await entree(location))
      await reservation(24, 26)
      assert.deepEqual(await listUnreturnedOccupations(), [])
    })

    it('ne bloque ni sur une entrée en saisie, ni sur une occupation annulée', async () => {
      await entree(await reservation(-5, -1))
      await reservation(24, 26)

      const annulee = await reservation(-10, -8, { resource: FOURGON })
      await clore(await entree(annulee))
      assert.equal(await codeErreur(() => reservation(24, 26, { resource: FOURGON })), DB_EXCLUSION_VIOLATION)
      await asTenant((tx) =>
        tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP(3) where id = ${annulee}`),
      )
      await reservation(24, 26, { resource: FOURGON })
    })

    it('laisse prolonger l’occupation elle-même, sous le contrôle de chevauchement ordinaire', async () => {
      const location = await reservation(-5, -1)
      const suivante = await reservation(3, 5, { client: PETIT })
      await clore(await entree(location))

      // Jusqu'à la réservation suivante, pas au-delà (décision 3).
      assert.equal(await codeErreur(() => decaler(location, -5, 4)), DB_EXCLUSION_VIOLATION)
      await decaler(location, -5, 2)
      // Sa fin prévue est de nouveau à venir : la ressource n'est plus en retard.
      assert.deepEqual(await listUnreturnedOccupations(), [])
      await reservation(24, 26)
      assert.ok(suivante)
    })

    it('met en conflit les réservations déjà posées : raccourcir, confirmer, annuler passent ; déplacer, non', async () => {
      const location = await reservation(-5, -1)
      const suivante = await reservation(3, 5, { client: PETIT, titre: 'Livraison' })
      const demande = await reservation(30, 32, { client: PETIT, status: 'pending', titre: 'Demande' })
      const premiere = await entree(location)
      await clore(premiere)

      const [retard] = await listUnreturnedOccupations()
      assert.equal(retard.entryId, premiere)
      assert.equal(retard.resource.id, UTILITAIRE)
      assert.equal(retard.client.name, 'Atelier Durand')
      assert.equal(retard.booking?.id, location)
      assert.ok(retard.since.getTime() < Date.now() && retard.since.getTime() > Date.now() - 2 * 3_600_000)
      assert.deepEqual(
        retard.conflicts.map((booking) => [booking.id, booking.clientName]),
        [
          [suivante, 'Boulangerie Petit'],
          [demande, 'Boulangerie Petit'],
        ],
      )

      await decaler(suivante, 3, 4)
      assert.equal(await codeErreur(() => decaler(suivante, 6, 8)), DB_EXCLUSION_VIOLATION)
      await asTenant((tx) => tx.execute(sql`update bookings set status = 'confirmed' where id = ${demande}`))
      await asTenant((tx) =>
        tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP(3) where id = ${suivante}`),
      )
      assert.deepEqual(
        (await listUnreturnedOccupations())[0].conflicts.map((booking) => booking.id),
        [demande],
      )

      const fin = await sortie(location)
      await clore(fin)
      assert.deepEqual(await listUnreturnedOccupations(), [])
    })

    it('tient l’occupation d’un contrat : un bureau non libéré ne se réserve plus', async () => {
      const occupation = await occupationDeContrat(-30, -1)
      const premiere = await ouvrir('entry', { kind: 'contract', id: CONTRAT }, `b:${occupation}`)
      await clore(premiere)

      assert.equal(await codeErreur(() => reservation(24, 26, { resource: BUREAU })), DB_EXCLUSION_VIOLATION)
      const [retard] = await listUnreturnedOccupations()
      assert.equal(retard.contract?.reference, 'EDL-7')
      assert.equal(retard.booking, null)

      // Le contrat reconduit prolonge sa propre occupation : la ressource n'est plus en retard.
      await bases.owner.db.transaction(async (tx) => {
        await tx.execute(sql`set @app_contract_occupation_sync = 'on'`)
        try {
          await tx.execute(sql`
            update bookings set ends_at = date_add(CURRENT_TIMESTAMP(3), interval 10 day) where id = ${occupation}`)
        } finally {
          await tx.execute(sql`set @app_contract_occupation_sync = null`)
        }
      })
      await reservation(24 * 20, 24 * 20 + 2, { resource: BUREAU })
    })

    it('dit à l’équipe pourquoi le planning refuse la réservation', async () => {
      await enRetard()
      const debut = new Date(Date.now() + 24 * 3_600_000)
      try {
        await createBooking({
          resourceId: UTILITAIRE,
          startsAt: debut,
          endsAt: new Date(debut.getTime() + 2 * 3_600_000),
          title: 'Déménagement',
          clientId: PETIT,
          pricing: { mode: 'none' },
        })
        assert.fail('la réservation aurait dû être refusée')
      } catch (error) {
        assert.ok(error instanceof BookingConflictError, String(error))
        assert.deepEqual(error.conflicts, [])
        assert.match(error.message, /^Ressource non restituée : « Utilitaire » attend son état des lieux de sortie\.$/)
      }
    })

    it('range la chronologie de la ressource par occupation, la non restituée signalée', async () => {
      const ancienne = await reservation(-50, -48)
      const entreeAncienne = await entree(ancienne, 50)
      await clore(entreeAncienne)
      const sortieAncienne = await sortie(ancienne, 48)
      await clore(sortieAncienne)
      const { premiere } = await enRetard()

      const groupes = groupByOccupation(await listResourceTimeline(UTILITAIRE))
      assert.deepEqual(
        groupes.map((groupe) => [groupe.entry?.id, groupe.exit?.id ?? null, groupe.situation]),
        [
          [premiere, null, 'non_restituee'],
          [entreeAncienne, sortieAncienne, 'restituee'],
        ],
      )
      assert.ok(groupes[0].entry?.unreturnedSince)
    })
  })
})
