import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_INVOICE_LOCKED, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { InvoiceRefusedError } from './factures-erreurs.ts'
import {
  abandonDraft,
  addManualLine,
  creditInFull,
  findInvoice,
  issueInvoice,
  issueInvoices,
  listInvoices,
  prepareCreditNote,
  removeDraftLine,
  updateDraftInvoice,
  updateDraftLine,
} from './factures-queries.ts'
import {
  InvoiceRunInProgressError,
  listInvoiceRuns,
  previewInvoiceRun,
  runInvoicing,
} from './lot-queries.ts'

/**
 * Lot de facturation et cycle d'une facture (R13, R14, R15, ADR 026, 028),
 * par le code qu'utilisent les écrans, sous `app_centre` :
 *
 * - le lot d'un mois prépare une facture brouillon par client, qui réunit
 *   loyers, forfaits, réservations et actes, chaque ligne avec sa source ;
 * - rejoué, il ne crée ni facture ni ligne en double, et complète un brouillon
 *   avec ce qui est apparu depuis ; il est journalisé ;
 * - l'émission numérote et fige ; une facture émise ne se modifie plus ;
 * - un avoir total libère les sources, qu'un lot rejoué refacture ; un avoir
 *   partiel non.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Année civile du centre : celle que porte le numéro. */
const ANNEE = todayIsoDate('Europe/Paris').slice(0, 4)

describe('lot de facturation', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f1d01'
  const DURAND = '01a00000-0000-7000-8000-0000000f1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f1c02'
  const SALLE = '01a00000-0000-7000-8000-0000000f1b01'
  const LOYER_DURAND = '01a00000-0000-7000-8000-0000000f1a01'
  const BUREAU_PETIT = '01a00000-0000-7000-8000-0000000f1a02'
  const OUVERTURE = '01a00000-0000-7000-8000-0000000f1e01'
  const STANDARD = '01a00000-0000-7000-8000-0000000f1e02'

  const OCTOBRE = '2026-10'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS',
      address_line1 = '1 rue de l''Exemple',
      postal_code = '38070',
      city = 'Saint-Quentin-Fallavier',
      siren = '123456789',
      vat_number = 'FR32123456789',
      bank_iban = 'FR7630006000011234567890189',
      recurring_billing_timing = 'in_advance',
      prorata_rule = 'calendar_days'
    where id = ${DEFAULT_TENANT_ID}`

  /** Réservation confirmée de deux heures à 25 € HT, prix figé (R11). */
  const reservation = async (clientId: string, jour: string, chiffree = true) => {
    await asTenant((tx) =>
      chiffree
        ? tx.execute(sql`
            insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title,
                                  quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                                  quote_currency, quoted_at)
            values (${SALLE}, ${clientId}, 'staff', ${`${jour}T08:00:00Z`}, ${`${jour}T10:00:00Z`},
                    'Réunion', 'hour', 2, 2500, 2000, 'EUR', now())`)
        : tx.execute(sql`
            insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
            values (${SALLE}, ${clientId}, 'staff', ${`${jour}T12:00:00Z`}, ${`${jour}T13:00:00Z`}, 'Sans devis')`),
    )
  }

  const pliOuvert = async (clientId: string, instant: string) => {
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (client_id, status, opened_at, opened_by, sender)
        values (${clientId}, 'opened', ${instant}, ${ACCUEIL}, 'URSSAF')`),
    )
  }

  /** Factures d'un client, brouillons abandonnés exclus, avec leurs lignes vivantes. */
  const facturesDe = async (clientId: string) =>
    (await listInvoices({ clientId })).filter((invoice) => invoice.kind === 'invoice')

  const factureDuLot = async (clientId: string) => {
    const [invoice] = (await facturesDe(clientId)).filter((row) => row.status !== 'cancelled')
    assert.ok(invoice, 'le client devrait avoir sa facture de lot')
    const detail = await findInvoice(invoice.id)
    assert.ok(detail)
    return detail
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await owner.db.execute(identiteDuCentre)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'exploitant@centre.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', 'active', '3 rue du Four', '69001', 'Lyon')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-L', 'Salle Europe')`)

      // Loyer sans ligne : 900 € HT par mois depuis janvier.
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${LOYER_DURAND}, ${DURAND}, 'CT-DURAND', 'domiciliation', 'active', '2026-01-01', 90000)`)

      // Contrat à lignes qui commence le 10 octobre : un bureau récurrent et
      // des frais de dossier ponctuels. Brouillon, lignes, puis activation.
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${BUREAU_PETIT}, ${PETIT}, 'CT-PETIT', 'bureau', 'draft', '2026-10-10', 0)`)
      await tx.execute(sql`
        insert into contract_lines (contract_id, description, quantity, unit, unit_price_cents,
                                    vat_rate_bp, is_recurring, position)
        values (${BUREAU_PETIT}, 'Bureau 3', 1, 'month', 60000, 2000, true, 0),
               (${BUREAU_PETIT}, 'Frais de dossier', 1, 'unit', 15000, 2000, false, 1)`)
      await tx.execute(sql`update contracts set status = 'active' where id = ${BUREAU_PETIT}`)

      // Catalogue : l'ouverture d'un pli à 3 €, le standard à 50 € par mois.
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${OUVERTURE}, 'courrier.ouverture', 'Ouverture et numérisation', 'act', 'unit', 300),
          (${STANDARD}, null, 'Standard téléphonique', 'package', 'month', 5000)`)
      // Durand : deux ouvertures incluses par mois, 2,50 € au-delà ; le standard depuis septembre.
      await tx.execute(sql`
        insert into subscribed_services (client_id, service_id, quantity, unit, unit_price_cents,
                                         vat_rate_bp, included_quantity, starts_on)
        values (${DURAND}, ${OUVERTURE}, 1, 'unit', 250, 2000, 2, '2026-01-01'),
               (${DURAND}, ${STANDARD}, 1, 'month', 5000, 2000, null, '2026-09-01')`)
    })

    // Consommations de septembre (facturées par le lot d'octobre) et d'octobre (pas encore).
    await reservation(DURAND, '2026-09-10')
    await reservation(DURAND, '2026-10-05')
    await reservation(PETIT, '2026-09-11', false)
    await pliOuvert(DURAND, '2026-09-03T09:00:00Z')
    await pliOuvert(DURAND, '2026-09-04T09:00:00Z')
    await pliOuvert(DURAND, '2026-09-05T09:00:00Z')
    await pliOuvert(PETIT, '2026-09-20T09:00:00Z')
    await pliOuvert(PETIT, '2026-10-02T09:00:00Z')
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
        siren = null, vat_number = null, bank_iban = null,
        recurring_billing_timing = 'in_advance', prorata_rule = 'calendar_days'
      where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('une facture par client et par période (R15)', () => {
    it('annonce, puis prépare les brouillons qui réunissent loyers, forfaits, réservations et actes', async () => {
      const apercu = await previewInvoiceRun(OCTOBRE)
      const durandPrevu = apercu.clients.find((client) => client.clientId === DURAND)
      assert.ok(durandPrevu)
      // 900 € de loyer, 50 € de standard, 50 € de réservation, 2 actes inclus et un à 2,50 €.
      assert.equal(durandPrevu.totals.exclTaxCents, 90_000 + 5_000 + 5_000 + 250)

      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesCreated, 2)
      assert.equal(report.invoicesUpdated, 0)

      const durand = await factureDuLot(DURAND)
      assert.equal(durand.invoice.status, 'draft')
      assert.equal(durand.invoice.periodStart, '2026-10-01')
      assert.equal(durand.invoice.periodEnd, '2026-10-31')
      assert.deepEqual(
        durand.lines.map((line) => [line.kind, line.netAmountCents]),
        [
          ['rent', 90_000],
          ['package', 5_000],
          ['booking', 5_000],
          ['act', 0],
          ['act', 0],
          ['act', 250],
        ],
      )
      assert.match(durand.lines[3].description, /inclus/)
      assert.ok(durand.lines.every((line) => line.contractId || line.bookingId || line.mailItemId || line.subscribedServiceId))
      // Totaux tenus par la base, identiques à l'aperçu.
      assert.equal(durand.invoice.totalExclTaxCents, durandPrevu.totals.exclTaxCents)
      assert.equal(durand.invoice.totalTaxCents, durandPrevu.totals.taxCents)

      const petit = await factureDuLot(PETIT)
      assert.deepEqual(
        petit.lines.map((line) => [line.kind, line.description, line.netAmountCents]),
        [
          // Du 10 au 31 octobre : 22/31 de 600 €.
          ['rent', 'Bureau 3 — contrat CT-PETIT', Math.round((60_000 * 22) / 31)],
          ['rent', 'Frais de dossier — contrat CT-PETIT', 15_000],
          ['act', 'Ouverture et numérisation — pli ouvert le 20/09/2026', 300],
        ],
      )
      assert.equal(petit.lines[0].prorataNumerator, 22)
      assert.equal(petit.lines[0].prorataDenominator, 31)
      assert.equal(petit.lines[1].periodStart, '2026-10-10')

      // La réservation sans prix figé n'est pas facturée : elle est signalée.
      assert.ok(
        report.warnings?.some(
          (warning) => warning.clientId === PETIT && /sans prix figé/.test(warning.message),
        ),
      )

      const [lot] = await listInvoiceRuns()
      assert.equal(lot.status, 'completed')
      assert.equal(lot.periodStart, '2026-10-01')
      assert.ok(lot.finishedAt)
      assert.equal(lot.report.invoicesCreated, 2)
    })

    it('rejoué, ne crée aucun doublon, et complète le brouillon de ce qui est apparu depuis', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const avant = await factureDuLot(DURAND)

      const rejoue = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(rejoue.report.invoicesCreated, 0)
      assert.equal(rejoue.report.invoicesUpdated, 0)
      assert.equal(rejoue.report.linesCreated, 0)
      // Rien n'a été tenté puis refusé par la base : le lot savait ce qui était facturé.
      assert.deepEqual(
        rejoue.report.warnings?.filter((warning) => /non préparée/.test(warning.message)),
        [],
      )
      assert.equal((await facturesDe(DURAND)).length, 1)
      assert.equal((await factureDuLot(DURAND)).lines.length, avant.lines.length)

      // Une réservation de septembre saisie après coup : le lot rejoué l'ajoute au même brouillon.
      await reservation(DURAND, '2026-09-25')
      const complete = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(complete.report.invoicesCreated, 0)
      assert.equal(complete.report.invoicesUpdated, 1)
      assert.equal(complete.report.linesCreated, 1)
      const apres = await factureDuLot(DURAND)
      assert.equal(apres.invoice.id, avant.invoice.id)
      assert.equal(apres.lines.length, avant.lines.length + 1)
      assert.equal(apres.invoice.totalExclTaxCents, avant.invoice.totalExclTaxCents + 5_000)

      const lots = await listInvoiceRuns()
      assert.equal(lots.length, 3)
      assert.ok(lots.every((lot) => lot.status === 'completed'))
    })

    it('rend facturable ce qu’un brouillon abandonné ou une ligne retirée tenait', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const durand = await factureDuLot(DURAND)
      const reservationLigne = durand.lines.find((line) => line.kind === 'booking')
      assert.ok(reservationLigne)
      await removeDraftLine(durand.invoice.id, reservationLigne.id)
      assert.equal((await factureDuLot(DURAND)).lines.length, durand.lines.length - 1)

      await abandonDraft(durand.invoice.id)
      assert.equal((await facturesDe(DURAND)).length, 0)

      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesCreated, 1)
      assert.equal((await factureDuLot(DURAND)).lines.length, durand.lines.length)
    })

    it('n’accepte qu’un lot à la fois, et libère un lot interrompu', async () => {
      await owner.client`
        insert into invoice_runs (tenant_id, period_start, period_end, created_by)
        values (${DEFAULT_TENANT_ID}, '2026-10-01', '2026-10-31', ${ACCUEIL})`
      await assert.rejects(runInvoicing(OCTOBRE, ACCUEIL), InvoiceRunInProgressError)

      // Resté en cours depuis une heure : réputé interrompu, il cède la place.
      await owner.client`update invoice_runs set started_at = now() - interval '1 hour'`
      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesCreated, 2)
      const lots = await listInvoiceRuns()
      assert.deepEqual(lots.map((lot) => lot.status).sort(), ['completed', 'failed'])
    })

    it('facture le récurrent du mois écoulé quand le centre facture à terme échu', async () => {
      await owner.client`update tenants set recurring_billing_timing = 'in_arrears' where id = ${DEFAULT_TENANT_ID}`
      await runInvoicing(OCTOBRE, ACCUEIL)
      const durand = await factureDuLot(DURAND)
      const loyer = durand.lines.find((line) => line.kind === 'rent')
      assert.equal(loyer?.periodStart, '2026-09-01')
      assert.equal(loyer?.periodEnd, '2026-09-30')
      // Le contrat de Petit commence en octobre : rien d'échu en septembre.
      const petit = await factureDuLot(PETIT)
      assert.deepEqual(
        petit.lines.map((line) => line.kind),
        ['act'],
      )
    })
  })

  describe('émission, immutabilité, avoirs (ADR 026)', () => {
    it('émet un brouillon : numéro sans trou, puis plus rien ne se modifie', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const durand = await factureDuLot(DURAND)
      const numero = await issueInvoice(durand.invoice.id, ACCUEIL)
      assert.equal(numero, `FA-${ANNEE}-0001`)

      const emise = await findInvoice(durand.invoice.id)
      assert.equal(emise?.invoice.status, 'issued')
      assert.ok(emise?.invoice.sellerSnapshot)
      assert.equal(emise?.invoice.buyerSnapshot?.name, 'Atelier Durand')
      assert.equal(emise?.invoice.legalMentions?.recoveryIndemnityCents, 4000)

      await assert.rejects(
        updateDraftLine(durand.invoice.id, durand.lines[0].id, { description: 'Autre', quantity: 2 }),
        InvoiceRefusedError,
      )
      await assert.rejects(
        addManualLine(durand.invoice.id, {
          kind: 'other',
          description: 'Ajout',
          quantity: 1,
          unitPriceCents: 100,
          vatRateBp: 2000,
          vatCategory: 'S',
          vatExemptionReason: null,
          periodStart: null,
          periodEnd: null,
        }),
        InvoiceRefusedError,
      )
      await assert.rejects(issueInvoice(durand.invoice.id, ACCUEIL), InvoiceRefusedError)
      // Même en écrivant directement : la base refuse.
      let code: string | undefined
      try {
        await asTenant((tx) => tx.execute(sql`update invoice_lines set quantity = 2 where invoice_id = ${durand.invoice.id}`))
      } catch (error) {
        code = pgErrorCode(error)
      }
      assert.equal(code, PG_INVOICE_LOCKED)

      // Un lot rejoué ne touche pas une facture émise : il signale ce qui reste.
      await reservation(DURAND, '2026-09-26')
      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesUpdated, 0)
      assert.ok(report.warnings?.some((warning) => warning.clientId === DURAND && /déjà émise/.test(warning.message)))
      assert.equal((await findInvoice(durand.invoice.id))?.lines.length, durand.lines.length)
    })

    it('émet en groupe, chacun pour soi, et dit ce qui manque', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const durand = await factureDuLot(DURAND)
      const petit = await factureDuLot(PETIT)
      // Petit sans adresse : son émission est refusée, celle de Durand passe.
      await owner.client`update clients set address_line1 = null where id = ${PETIT}`
      const resultat = await issueInvoices([durand.invoice.id, petit.invoice.id], ACCUEIL)
      assert.deepEqual(resultat.issued, [{ id: durand.invoice.id, number: `FA-${ANNEE}-0001` }])
      assert.equal(resultat.refused.length, 1)
      assert.equal(resultat.refused[0].clientName, 'Boulangerie Petit')
      assert.match(resultat.refused[0].message, /adresse du client/)
    })

    it('modifie un brouillon : conditions, ligne ajoutée, ligne modifiée', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const petit = await factureDuLot(PETIT)
      await updateDraftInvoice(petit.invoice.id, {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        paymentTermsDays: 15,
        expectedPaymentMethod: 'transfer',
        buyerReference: 'BC-42',
        notes: null,
      })
      await addManualLine(petit.invoice.id, {
        kind: 'discount',
        description: 'Geste commercial',
        quantity: 1,
        unitPriceCents: 1_000,
        vatRateBp: 2000,
        vatCategory: 'S',
        vatExemptionReason: null,
        periodStart: null,
        periodEnd: null,
      })
      const frais = petit.lines.find((line) => line.description.startsWith('Frais'))
      assert.ok(frais)
      await updateDraftLine(petit.invoice.id, frais.id, {
        description: 'Frais de dossier (offerts à moitié)',
        quantity: 1,
        // Ligne tirée d'un contrat : son prix ne se réécrit pas.
        unitPriceCents: 1,
      })

      const apres = await findInvoice(petit.invoice.id)
      assert.ok(apres)
      assert.equal(apres.invoice.paymentTermsDays, 15)
      assert.equal(apres.invoice.buyerReference, 'BC-42')
      const remise = apres.lines.at(-1)
      assert.equal(remise?.kind, 'discount')
      assert.equal(remise?.unitPriceCents, -1_000)
      const fraisApres = apres.lines.find((line) => line.id === frais.id)
      assert.equal(fraisApres?.description, 'Frais de dossier (offerts à moitié)')
      assert.equal(fraisApres?.unitPriceCents, 15_000)
      assert.equal(
        apres.invoice.totalExclTaxCents,
        petit.invoice.totalExclTaxCents - 1_000,
      )

      const numero = await issueInvoice(petit.invoice.id, ACCUEIL)
      const emise = await findInvoice(petit.invoice.id)
      assert.equal(emise?.invoice.number, numero)
      assert.equal(emise?.invoice.legalMentions?.paymentTermsDays, 15)
    })

    it('annule par un avoir total : les sources redeviennent facturables', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const durand = await factureDuLot(DURAND)
      await issueInvoice(durand.invoice.id, ACCUEIL)

      const avoir = await creditInFull(durand.invoice.id, 'Erreur de période', ACCUEIL)
      assert.equal(avoir.number, `AV-${ANNEE}-0001`)
      const origine = await findInvoice(durand.invoice.id)
      assert.equal(origine?.invoice.status, 'cancelled')
      assert.equal(origine?.invoice.creditedCents, origine?.invoice.totalInclTaxCents)
      assert.ok(origine?.lines.every((line) => line.releasedAt !== null))
      const detailAvoir = await findInvoice(avoir.id)
      assert.equal(detailAvoir?.invoice.kind, 'credit_note')
      assert.equal(detailAvoir?.invoice.notes, 'Erreur de période')
      assert.equal(detailAvoir?.lines.length, durand.lines.length)
      assert.equal(detailAvoir?.lines[0].creditedLineDescription, durand.lines[0].description)
      assert.equal(detailAvoir?.original?.id, durand.invoice.id)
      assert.equal(detailAvoir?.invoice.legalMentions?.creditedInvoiceNumber, origine?.invoice.number)

      // Un second avoir total est refusé : il ne reste rien à créditer.
      await assert.rejects(creditInFull(durand.invoice.id, 'Encore', ACCUEIL), InvoiceRefusedError)

      // Le lot rejoué refacture les sources libérées, sur une nouvelle facture.
      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesCreated, 1)
      const nouvelle = await factureDuLot(DURAND)
      assert.notEqual(nouvelle.invoice.id, durand.invoice.id)
      assert.equal(nouvelle.lines.length, durand.lines.length)
      assert.equal(nouvelle.invoice.totalInclTaxCents, durand.invoice.totalInclTaxCents)
    })

    it('établit un avoir partiel : réduit, il crédite sans libérer les sources', async () => {
      await runInvoicing(OCTOBRE, ACCUEIL)
      const petit = await factureDuLot(PETIT)
      await issueInvoice(petit.invoice.id, ACCUEIL)

      const brouillonId = await prepareCreditNote(petit.invoice.id, 'Frais de dossier remisés')
      // Un second appel reprend le brouillon ouvert, sans en créer un autre.
      assert.equal(await prepareCreditNote(petit.invoice.id, 'Doublon'), brouillonId)
      const brouillon = await findInvoice(brouillonId)
      assert.ok(brouillon)
      for (const line of brouillon.lines.filter((candidate) => !candidate.description.startsWith('Frais'))) {
        await removeDraftLine(brouillonId, line.id)
      }
      const frais = (await findInvoice(brouillonId))?.lines[0]
      assert.ok(frais)
      // La moitié des frais : 75 € HT.
      await updateDraftLine(brouillonId, frais.id, {
        description: frais.description,
        quantity: 1,
        unitPriceCents: 7_500,
      })
      const numero = await issueInvoice(brouillonId, ACCUEIL)
      assert.equal(numero, `AV-${ANNEE}-0001`)

      const origine = await findInvoice(petit.invoice.id)
      assert.equal(origine?.invoice.status, 'issued')
      assert.equal(origine?.invoice.creditedCents, 9_000)
      assert.ok(origine?.lines.every((line) => line.releasedAt === null))

      // Rien n'est libéré : le lot rejoué ne refacture rien.
      const { report } = await runInvoicing(OCTOBRE, ACCUEIL)
      assert.equal(report.invoicesCreated, 0)
      assert.equal(report.linesCreated, 0)
    })
  })
})
