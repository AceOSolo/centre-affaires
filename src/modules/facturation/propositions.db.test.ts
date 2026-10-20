import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, eq, sql } from 'drizzle-orm'

import { DB_CLIENT_SCOPE_REFUSED, DB_PROPOSAL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { cancelBooking, createBookingRequest } from '../reservations/queries.ts'
import { bookings } from '../reservations/schema.ts'
import {
  ProposalRefusedError,
  addProposalLine,
  cancelProposal,
  createProposalInTransaction,
  findProposal,
  listProposalsForDolibarr,
  markProposalSent,
  recordProposalOutcome,
  reopenProposal,
  removeProposalLine,
  validateProposal,
} from './propositions-queries.ts'
import { toDolibarrProposal, type LineDraft } from './propositions.ts'
import { addRatePlanItem } from './queries.ts'
import { proposalLines, proposals } from './schema-devis.ts'

/**
 * Devis transmis à Dolibarr, contre la base (ADR 043) : création avec la
 * demande, validation d'office d'une salle chiffrée, passages d'état tenus par
 * la base (`CA016`), lignes figées hors brouillon, annulation qui suit celle
 * de la réservation, et reprise par Dolibarr rejouable sans effet.
 *
 *   TEST_DB_NAME=centre_affaires_test npm test
 */
describe('devis transmis à Dolibarr', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const SALLE = '01a00000-0000-7000-8000-000000e0b001'
  const VEHICULE = '01a00000-0000-7000-8000-000000e0b002'
  const CLIENT = '01a00000-0000-7000-8000-000000e0c001'
  const GRILLE = '01a00000-0000-7000-8000-000000e0a001'
  const ACCUEIL = '01a00000-0000-7000-8000-000000e0s001'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const creneau = (debut: string, fin: string) => ({
    startsAt: wallClockToUtc(debut, 'Europe/Paris'),
    endsAt: wallClockToUtc(fin, 'Europe/Paris'),
  })

  const demandeur = {
    title: 'Comité de direction',
    requesterName: 'Camille Dupont',
    requesterEmail: 'Camille@Exemple.fr',
    requesterPhone: '0600000000',
  }

  const ligneManuelle: LineDraft = {
    source: 'manual',
    label: 'Domiciliation — forfait mensuel',
    description: null,
    unit: 'month',
    quantity: 12,
    unitPriceCents: 3_000,
    discountBp: 1_000,
    discountAmountCents: null,
    vatRateBp: 2_000,
    resourceId: null,
    serviceId: null,
    ratePlanItemId: null,
  }

  const domiciliation = () =>
    asTenant((tx) =>
      createProposalInTransaction(tx, {
        product: 'domiciliation',
        channel: 'public',
        requesterName: 'Léa Martin',
        requesterEmail: 'lea@atelier.fr',
        requesterCompany: 'Atelier Martin',
        answers: { situation: 'creation', raisonSociale: 'Atelier Martin', forme: 'sas', debut: '2026-11-01' },
        lines: [],
      }),
    )

  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return error instanceof ProposalRefusedError ? DB_PROPOSAL_REFUSED : dbErrorCode(error)
    }
    return undefined
  }

  const lire = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(proposals).where(eq(proposals.id, id)))
    return row
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'proposal_lines',
      'proposals',
      'document_sequences',
      'bookings',
      'rate_plan_items',
      'rate_plans',
      'clients',
      'resources',
      'staff_members',
    )
    await bases.owner.db.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'staff')`)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-MB', 'Salle Mont Blanc'),
          (${VEHICULE}, 'vehicule', 'VEH-01', 'Camion 12 m³')`)
      await tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Acme SAS')`)
      await tx.execute(sql`insert into rate_plans (id, name, is_default) values (${GRILLE}, 'Tarifs publics 2026', true)`)
    })
    await addRatePlanItem({ ratePlanId: GRILLE, resourceType: 'salle', unit: 'half_day', amountCents: 9_000 })
    await addRatePlanItem({ ratePlanId: GRILLE, resourceType: 'vehicule', unit: 'day', amountCents: 8_500 })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('création avec la demande', () => {
    it('numérote le devis, reprend le prix figé et le valide d’office pour une salle', async () => {
      const created = await createBookingRequest({
        resourceId: SALLE,
        ...creneau('2026-11-03T09:00', '2026-11-03T13:00'),
        ...demandeur,
        proposal: { product: 'espace', answers: { participants: 8, usage: 'reunion' }, timeZone: 'Europe/Paris' },
      })
      assert.match(created.proposal?.number ?? '', /^DV-\d{4}-0001$/)
      assert.equal(created.proposal?.status, 'ready')

      const detail = await findProposal(created.proposal!.id)
      assert.equal(detail?.bookingId, created.id)
      assert.equal(detail?.requesterEmail, 'camille@exemple.fr')
      assert.ok(detail?.validatedAt)
      assert.equal(detail?.validatedByStaffId, null)
      assert.equal(detail?.lines.length, 1)
      const [line] = detail!.lines
      assert.equal(line.source, 'booking')
      assert.equal(line.unit, 'half_day')
      assert.equal(line.amountCents, 9_000)
      assert.equal(line.resourceId, SALLE)
      assert.match(line.label, /^Salle Mont Blanc — mardi 3 novembre 2026, 09:00 – 13:00$/)
    })

    it('laisse un camion chiffré en brouillon pour l’accueil', async () => {
      const created = await createBookingRequest({
        resourceId: VEHICULE,
        ...creneau('2026-11-03T08:00', '2026-11-03T18:00'),
        ...demandeur,
        proposal: { product: 'vehicule', answers: { usage: 'demenagement', trajet: 'Lyon', permis: true }, timeZone: 'Europe/Paris' },
      })
      assert.equal(created.proposal?.status, 'draft')
      const detail = await findProposal(created.proposal!.id)
      assert.equal(detail?.lines[0].amountCents, 8_500)
    })

    it('numérote sans trou d’un devis à l’autre', async () => {
      const a = await domiciliation()
      const b = await domiciliation()
      assert.equal(Number(b.number.slice(-4)) - Number(a.number.slice(-4)), 1)
    })

    it('refuse un devis né autrement que brouillon', async () => {
      assert.equal(
        await code(() =>
          asTenant((tx) =>
            tx.execute(sql`insert into proposals (id, number, product, channel, status, requester_email, answers, validated_at)
              values (uuid(), 'DV-X', 'domiciliation', 'public', 'ready', 'a@b.fr', '{}', now(3))`),
          ),
        ),
        DB_PROPOSAL_REFUSED,
      )
    })
  })

  describe('cycle tenu par la base', () => {
    it('refuse de valider un devis sans ligne', async () => {
      const proposal = await domiciliation()
      assert.equal(await code(() => validateProposal(proposal.id, ACCUEIL)), DB_PROPOSAL_REFUSED)
    })

    it('valide, fige les lignes, puis rouvre un devis pas encore repris', async () => {
      const proposal = await domiciliation()
      await addProposalLine(proposal.id, ligneManuelle)
      assert.equal(await validateProposal(proposal.id, ACCUEIL), true)
      const ready = await lire(proposal.id)
      assert.equal(ready.status, 'ready')
      assert.equal(ready.validatedByStaffId, ACCUEIL)

      // Validé : ni ligne ajoutée, ni réponse changée.
      assert.equal(await code(() => addProposalLine(proposal.id, ligneManuelle)), DB_PROPOSAL_REFUSED)
      assert.equal(
        await code(() =>
          asTenant((tx) => tx.update(proposals).set({ answers: { situation: 'immatriculee' } }).where(eq(proposals.id, proposal.id))),
        ),
        DB_PROPOSAL_REFUSED,
      )

      assert.equal(await reopenProposal(proposal.id), true)
      const reopened = await lire(proposal.id)
      assert.equal(reopened.status, 'draft')
      assert.equal(reopened.validatedAt, null)
      assert.equal(reopened.validatedByStaffId, null)
      const [line] = (await findProposal(proposal.id))!.lines
      await removeProposalLine(proposal.id, line.id)
      assert.equal((await findProposal(proposal.id))!.lines.length, 0)
    })

    it('calcule le montant de la ligne par la règle d’arrondi unique', async () => {
      const proposal = await domiciliation()
      await addProposalLine(proposal.id, ligneManuelle)
      const [line] = (await findProposal(proposal.id))!.lines
      // 12 × 30 € − 10 % = 324 €.
      assert.equal(line.amountCents, 32_400)
    })

    it('ne supprime ni un devis ni une ligne', async () => {
      const proposal = await domiciliation()
      await addProposalLine(proposal.id, ligneManuelle)
      assert.equal(await code(() => asTenant((tx) => tx.delete(proposalLines).where(eq(proposalLines.proposalId, proposal.id)))), DB_PROPOSAL_REFUSED)
      assert.equal(await code(() => asTenant((tx) => tx.delete(proposals).where(eq(proposals.id, proposal.id)))), DB_PROPOSAL_REFUSED)
    })
  })

  describe('reprise par Dolibarr', () => {
    const pret = async () => {
      const proposal = await domiciliation()
      await addProposalLine(proposal.id, ligneManuelle)
      await validateProposal(proposal.id, ACCUEIL)
      return proposal
    }

    it('liste les devis prêts au format convenu', async () => {
      const proposal = await pret()
      const [listed] = await listProposalsForDolibarr({ status: 'ready' })
      const payload = toDolibarrProposal(listed)
      assert.equal(payload.id, proposal.id)
      assert.equal(payload.reference, proposal.number)
      assert.equal(payload.tiers.nom, 'Atelier Martin')
      assert.equal(payload.tiers.clientId, null)
      assert.equal(payload.lignes[0].prixUnitaireHt, '30.00')
      assert.equal(payload.lignes[0].remisePourcent, '10')
      assert.equal(payload.lignes[0].tauxTva, '20')
      assert.deepEqual(payload.totaux, { htCentimes: 32_400, tvaCentimes: 6_480, ttcCentimes: 38_880 })
      assert.ok(payload.reponses.some((reponse) => reponse.libelle === 'Forme juridique' && reponse.valeur === 'SAS ou SASU'))
    })

    it('marque le devis transmis, une seule fois, et rejoue sans effet', async () => {
      const proposal = await pret()
      assert.deepEqual(await markProposalSent(proposal.id, { id: '412', ref: 'PR2611-0007' }), { result: 'ok' })
      const sent = await lire(proposal.id)
      assert.equal(sent.status, 'sent')
      assert.equal(sent.dolibarrRef, 'PR2611-0007')
      assert.ok(sent.sentAt)
      assert.deepEqual(await markProposalSent(proposal.id, { id: '412', ref: 'PR2611-0007' }), { result: 'ok' })
      assert.equal((await markProposalSent(proposal.id, { id: '999', ref: null })).result, 'refuse')
      assert.equal((await listProposalsForDolibarr({ status: 'ready' })).length, 0)
      // Transmis : il ne revient plus en brouillon.
      assert.equal(await code(() => asTenant((tx) => tx.update(proposals).set({ status: 'draft' }).where(eq(proposals.id, proposal.id)))), DB_PROPOSAL_REFUSED)
    })

    it('enregistre l’issue d’un devis transmis, pas d’un devis prêt', async () => {
      const proposal = await pret()
      assert.equal((await recordProposalOutcome(proposal.id, 'accepted')).result, 'refuse')
      await markProposalSent(proposal.id, { id: '413', ref: null })
      assert.deepEqual(await recordProposalOutcome(proposal.id, 'accepted'), { result: 'ok' })
      assert.deepEqual(await recordProposalOutcome(proposal.id, 'accepted'), { result: 'ok' })
      assert.equal((await recordProposalOutcome(proposal.id, 'refused')).result, 'refuse')
      assert.ok((await lire(proposal.id)).outcomeAt)
    })

    it('répond « introuvable » pour un devis inconnu', async () => {
      assert.deepEqual(await markProposalSent('01a00000-0000-7000-8000-00000000dead', { id: '1', ref: null }), { result: 'introuvable' })
    })
  })

  describe('annulation', () => {
    it('suit l’annulation de la réservation, devis transmis compris', async () => {
      const created = await createBookingRequest({
        resourceId: SALLE,
        ...creneau('2026-11-04T09:00', '2026-11-04T13:00'),
        ...demandeur,
        proposal: { product: 'espace', answers: { participants: 4, usage: 'entretien' }, timeZone: 'Europe/Paris' },
      })
      await markProposalSent(created.proposal!.id, { id: '414', ref: 'PR2611-0008' })
      await cancelBooking(created.id, 'Demande refusée : salle en travaux.')
      const cancelled = await lire(created.proposal!.id)
      assert.equal(cancelled.status, 'cancelled')
      assert.ok(cancelled.cancelledAt)
      assert.equal(cancelled.cancellationReason, 'Demande refusée : salle en travaux.')
      const [listed] = await listProposalsForDolibarr({ status: 'cancelled', since: new Date(Date.now() - 60_000) })
      assert.equal(listed.id, created.proposal!.id)
    })

    it('annule un brouillon à la main, et un devis annulé ne change plus', async () => {
      const proposal = await domiciliation()
      assert.equal(await cancelProposal(proposal.id, 'Doublon'), true)
      assert.equal(await code(() => asTenant((tx) => tx.update(proposals).set({ status: 'draft' }).where(eq(proposals.id, proposal.id)))), DB_PROPOSAL_REFUSED)
    })
  })

  describe('portée client', () => {
    it('refuse un devis pour une autre entreprise, et toute modification par le client', async () => {
      const autre = '01a00000-0000-7000-8000-000000e0c002'
      await asTenant((tx) => tx.execute(sql`insert into clients (id, name) values (${autre}, 'Beta SARL')`))
      const depot = (clientId: string) =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [CLIENT],
          (tx) =>
            createProposalInTransaction(tx, {
              product: 'domiciliation',
              channel: 'client',
              clientId,
              answers: {},
              lines: [],
            }),
          bases.app.db,
        )
      assert.equal(await code(() => depot(autre)), DB_CLIENT_SCOPE_REFUSED)
      const proposal = await depot(CLIENT)
      assert.equal(proposal.status, 'draft')
      assert.equal(
        await code(() =>
          withClientScope(
            DEFAULT_TENANT_ID,
            [CLIENT],
            (tx) => tx.update(proposals).set({ staffNote: 'x' }).where(and(eq(proposals.id, proposal.id))),
            bases.app.db,
          ),
        ),
        DB_CLIENT_SCOPE_REFUSED,
      )
    })
  })

  it('garde la réservation et son devis ensemble : un conflit n’écrit ni l’un ni l’autre', async () => {
    const slot = creneau('2026-11-05T09:00', '2026-11-05T13:00')
    await createBookingRequest({ resourceId: SALLE, ...slot, ...demandeur, proposal: { product: 'espace', answers: {}, timeZone: 'Europe/Paris' } })
    await assert.rejects(
      createBookingRequest({ resourceId: SALLE, ...slot, ...demandeur, proposal: { product: 'espace', answers: {}, timeZone: 'Europe/Paris' } }),
    )
    const [{ n }] = (await asTenant((tx) => tx.select({ n: sql<number>`count(*)` }).from(proposals)))
    assert.equal(Number(n), 1)
    const [{ b }] = await asTenant((tx) => tx.select({ b: sql<number>`count(*)` }).from(bookings))
    assert.equal(Number(b), 1)
  })
})
