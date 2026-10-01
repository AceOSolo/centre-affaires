import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, eq, isNull, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  PG_INVOICE_INVALID,
  PG_INVOICE_LOCKED,
  PG_PAYMENT_REFUSED,
  PG_SEPA_MANDATE_LOCKED,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { DocumentKeyring } from '../../lib/chiffrement-documents.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { openIban, sealIban } from './iban.ts'
import { invoiceAmounts } from './montants.ts'
import {
  invoiceLines,
  invoices,
  payments,
  sepaMandates,
  type NewInvoiceLine,
} from './schema-factures.ts'

/**
 * Factures structurées (R13, R15, R16, ADR 026, ADR 027) : les garanties sont
 * en base, éprouvées ici sous `app_centre`, comme l'application les écrit.
 *
 * - une facture naît brouillon, sans numéro ; `issue_invoice()` la numérote
 *   sans trou, la date, fige le vendeur, l'acheteur et les mentions ;
 * - émise, elle ne change plus : toute correction passe par un avoir ;
 * - une source (réservation, pli, période d'un contrat ou d'une souscription)
 *   n'est facturée qu'une fois, hors avoir ;
 * - TVA par taux et totaux sont recalculés par la base depuis les lignes ;
 * - le statut de paiement se déduit des paiements et des avoirs ;
 * - un IBAN de mandat n'est jamais en clair.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

const PARIS = 'Europe/Paris'
/** Année civile du centre : celle que porte le numéro. */
const ANNEE = todayIsoDate(PARIS).slice(0, 4)

describe('factures', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  // Assez de connexions pour que les émissions concurrentes le soient vraiment.
  const app = createDatabase(appUrl ?? '', { max: 12 })

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f0d01'
  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const SALLE = '01a00000-0000-7000-8000-0000000f0b01'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f8'

  const trousseau: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const errorOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run()
    } catch (error) {
      return error
    }
    return undefined
  }
  const errorCode = async (run: () => Promise<unknown>) => pgErrorCode(await errorOf(run))

  /** Message de Postgres, sous l'enveloppe de Drizzle. */
  const messageOf = (error: unknown): string => {
    const messages: string[] = []
    for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
      messages.push(String((cause as { message?: unknown }).message ?? ''))
      cause = (cause as { cause?: unknown }).cause
    }
    return messages.join(' | ')
  }

  /** Brouillon de facture de septembre pour un client. */
  const brouillon = async (
    values: Partial<typeof invoices.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx
        .insert(invoices)
        .values({ clientId: DURAND, periodStart: '2026-09-01', periodEnd: '2026-09-30', ...values })
        .returning({ id: invoices.id }),
    )
    return row.id
  }

  type LigneSaisie = Omit<NewInvoiceLine, 'invoiceId' | 'kind' | 'description' | 'unitPriceCents' | 'vatRateBp'> &
    Partial<Pick<NewInvoiceLine, 'kind' | 'description' | 'unitPriceCents' | 'vatRateBp'>>

  /** Ligne libre à 20 % par défaut. */
  const ligne = async (invoiceId: string, values: LigneSaisie = {}) => {
    const [row] = await asTenant((tx) =>
      tx
        .insert(invoiceLines)
        .values({
          invoiceId,
          kind: 'other',
          description: 'Prestation',
          unitPriceCents: 10_000,
          vatRateBp: 2_000,
          ...values,
        })
        .returning(),
    )
    return row
  }

  const facture = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(invoices).where(eq(invoices.id, id)))
    return row
  }

  const lignes = (invoiceId: string) =>
    asTenant((tx) =>
      tx
        .select()
        .from(invoiceLines)
        .where(and(eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.deletedAt)))
        .orderBy(invoiceLines.position, invoiceLines.id),
    )

  const emettre = async (id: string): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select issue_invoice(${id}::uuid, ${ACCUEIL}::uuid) as numero`),
    )
    return row.numero as string
  }

  const brouillonAvoir = async (invoiceId: string, motif = 'Erreur de facturation'): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select draft_credit_note(${invoiceId}::uuid, ${motif}) as id`),
    )
    return row.id as string
  }

  const payer = (invoiceId: string, amountCents: number, values: Partial<typeof payments.$inferInsert> = {}) =>
    asTenant(async (tx) => {
      const [row] = await tx
        .insert(payments)
        .values({
          invoiceId,
          amountCents,
          paidOn: '2026-10-05',
          method: 'transfer',
          recordedBy: ACCUEIL,
          ...values,
        })
        .returning()
      return row
    })

  /** Facture émise d'une ligne de 100 € HT à 20 %. */
  const factureEmise = async (values: Partial<typeof invoices.$inferInsert> = {}) => {
    const id = await brouillon(values)
    await ligne(id)
    const numero = await emettre(id)
    return { id, numero }
  }

  /** Réservation de deux heures de salle à 25 € HT, prix figé (R11). */
  const reservation = async (clientId = DURAND, jour = '2026-09-10'): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title,
                              quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                              quote_currency, quoted_at)
        values (${SALLE}, ${clientId}, 'staff', ${`${jour}T08:00:00Z`}, ${`${jour}T10:00:00Z`}, 'Réunion',
                'hour', 2, 2500, 2000, 'EUR', now())
        returning id`),
    )
    return row.id as string
  }

  /** Pli ouvert et numérisé : un acte à facturer (R14). */
  const pliOuvert = async (clientId = DURAND): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (client_id, status, opened_at, opened_by, sender)
        values (${clientId}, 'opened', '2026-09-12T09:00:00Z', ${ACCUEIL}, 'URSSAF')
        returning id`),
    )
    return row.id as string
  }

  /** Service du catalogue : l'ouverture d'un pli, ou un forfait mensuel. */
  const service = async (nature: 'act' | 'package'): Promise<string> => {
    const [row] = await asTenant((tx) =>
      nature === 'act'
        ? tx.execute(sql`
            insert into services (code, name, nature, unit, unit_price_cents)
            values ('courrier.ouverture', 'Ouverture et numérisation', 'act', 'unit', 300) returning id`)
        : tx.execute(sql`
            insert into services (name, nature, unit, unit_price_cents)
            values ('Standard téléphonique', 'package', 'month', 5000) returning id`),
    )
    return row.id as string
  }

  /** Contrat de bureau actif, sans ressource (l'occupation n'est pas le sujet). */
  const contrat = async (clientId = DURAND): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${clientId}, ${`BUR-${clientId.slice(-2)}`}, 'bureau', 'active', '2026-01-01', 90000)
        returning id`),
    )
    return row.id as string
  }

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS',
      legal_form = 'SAS',
      share_capital_cents = 1000000,
      address_line1 = '1 rue de l''Exemple',
      postal_code = '38070',
      city = 'Saint-Quentin-Fallavier',
      siren = '123456789',
      siret = '12345678900012',
      vat_number = 'FR32123456789',
      rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189',
      bank_bic = 'AGRIFRPP',
      sepa_creditor_id = 'FR12ZZZ123456'
    where id = ${DEFAULT_TENANT_ID}`

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
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name, siret, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', '98765432100015', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', null, '3 rue du Four', '69001', 'Lyon')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-F', 'Salle')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null, sepa_creditor_id = null
      where id = ${DEFAULT_TENANT_ID}`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('montants tenus par la base', () => {
    it('calcule le net de chaque ligne et tient la TVA et les totaux du brouillon à jour', async () => {
      const id = await brouillon()
      await ligne(id, { unitPriceCents: 33, position: 0 })
      await ligne(id, { unitPriceCents: 33, position: 1 })
      await ligne(id, { unitPriceCents: 33, position: 2 })
      await ligne(id, { unitPriceCents: 1_500, vatRateBp: 1_000, position: 3 })
      await ligne(id, {
        kind: 'discount',
        description: 'Remise de bienvenue',
        unitPriceCents: -10,
        position: 4,
      })

      const enBase = await lignes(id)
      const attendu = invoiceAmounts(
        enBase.map((line) => ({
          id: line.id,
          position: line.position,
          netAmountCents: line.netAmountCents ?? 0,
          vatRateBp: line.vatRateBp,
          vatCategory: line.vatCategory,
        })),
      )
      for (const line of enBase) {
        assert.equal(line.vatAmountCents, attendu.lineVatCents.get(line.id), line.description)
        assert.equal(line.totalAmountCents, (line.netAmountCents ?? 0) + line.vatAmountCents)
      }
      const totaux = await facture(id)
      // 20 % sur 0,89 € de base (0,99 − 0,10) : 0,178 → 0,18 € ; 10 % sur 15 € : 1,50 €.
      assert.equal(totaux.totalExclTaxCents, 99 - 10 + 1_500)
      assert.equal(totaux.totalTaxCents, 18 + 150)
      assert.equal(totaux.totalTaxCents, attendu.totalTaxCents)
      assert.equal(totaux.totalInclTaxCents, totaux.totalExclTaxCents + totaux.totalTaxCents)
    })

    it('applique remise et prorata d’une ligne par la règle d’arrondi commune', async () => {
      const id = await brouillon()
      const loyer = await ligne(id, {
        kind: 'other',
        quantity: 1,
        unitPriceCents: 90_000,
        discountAmountCents: 10_000,
        prorataNumerator: 22,
        prorataDenominator: 31,
      })
      assert.equal(loyer.netAmountCents, 56_774)
    })

    it('ignore des totaux écrits par le code, et une ligne retirée sort des totaux', async () => {
      const id = await brouillon()
      const premiere = await ligne(id)
      await ligne(id, { unitPriceCents: 5_000 })
      await asTenant((tx) =>
        tx.update(invoices).set({ totalExclTaxCents: 1, totalTaxCents: 0, totalInclTaxCents: 1 }).where(eq(invoices.id, id)),
      )
      assert.equal((await facture(id)).totalExclTaxCents, 15_000)

      await asTenant((tx) =>
        tx.update(invoiceLines).set({ deletedAt: new Date() }).where(eq(invoiceLines.id, premiere.id)),
      )
      const apres = await facture(id)
      assert.equal(apres.totalExclTaxCents, 5_000)
      assert.equal(apres.totalInclTaxCents, 6_000)
    })
  })

  describe('émission', () => {
    it('numérote à l’émission seulement, date du jour du centre et fige les mentions', async () => {
      const id = await brouillon()
      await ligne(id)
      const avant = await facture(id)
      assert.equal(avant.number, null)
      assert.equal(avant.status, 'draft')

      const numero = await emettre(id)
      assert.equal(numero, `FA-${ANNEE}-0001`)

      const emise = await facture(id)
      const aujourdHui = todayIsoDate(PARIS)
      assert.equal(emise.number, numero)
      assert.equal(emise.status, 'issued')
      assert.equal(emise.issueDate, aujourdHui)
      assert.equal(emise.paymentTermsDays, 30)
      assert.equal(emise.dueDate, addDaysToIsoDate(aujourdHui, 30))
      assert.equal(emise.issuedBy, ACCUEIL)
      assert.equal(emise.totalInclTaxCents, 12_000)
      assert.equal(emise.sellerSnapshot?.siren, '123456789')
      assert.equal(emise.sellerSnapshot?.vatNumber, 'FR32123456789')
      assert.equal(emise.sellerSnapshot?.bankIban, 'FR7630006000011234567890189')
      assert.equal(emise.buyerSnapshot?.name, 'Atelier Durand')
      assert.equal(emise.buyerSnapshot?.siren, '987654321')
      assert.equal(emise.legalMentions?.recoveryIndemnityCents, 4_000)
      assert.equal(emise.legalMentions?.operationCategory, 'services')
      assert.match(emise.legalMentions?.latePaymentPenaltyText ?? '', /L\. 441-10/)
    })

    it('garde l’identité figée quand le centre ou le client change ensuite', async () => {
      const { id } = await factureEmise()
      await owner.client`update tenants set legal_name = 'Nouveau nom' where id = ${DEFAULT_TENANT_ID}`
      await asTenant((tx) => tx.execute(sql`update clients set name = 'Durand et fils' where id = ${DURAND}`))
      const emise = await facture(id)
      assert.equal(emise.sellerSnapshot?.legalName, 'Centre de démonstration SAS')
      assert.equal(emise.buyerSnapshot?.name, 'Atelier Durand')
    })

    it('numérote sans trou : un refus ne consomme pas de numéro', async () => {
      assert.equal((await factureEmise()).numero, `FA-${ANNEE}-0001`)

      // Un brouillon vide est refusé : son numéro n'est pas pris.
      const vide = await brouillon()
      assert.equal(await errorCode(() => emettre(vide)), PG_INVOICE_INVALID)

      assert.equal((await factureEmise()).numero, `FA-${ANNEE}-0002`)
      assert.equal((await factureEmise()).numero, `FA-${ANNEE}-0003`)
    })

    it('numérote sans trou ni doublon des émissions simultanées', async () => {
      const brouillons: string[] = []
      for (let index = 0; index < 10; index += 1) {
        const id = await brouillon()
        await ligne(id)
        brouillons.push(id)
      }
      const numeros = await Promise.all(brouillons.map((id) => emettre(id)))
      assert.deepEqual(
        [...numeros].sort(),
        Array.from({ length: 10 }, (_, index) => `FA-${ANNEE}-${String(index + 1).padStart(4, '0')}`),
      )
    })

    it('refuse d’émettre sans les mentions obligatoires, et dit lesquelles', async () => {
      await owner.client`update tenants set siren = null, siret = null, bank_iban = null where id = ${DEFAULT_TENANT_ID}`
      const id = await brouillon({ clientId: PETIT })
      await ligne(id, {})
      await asTenant((tx) => tx.execute(sql`update clients set address_line1 = null where id = ${PETIT}`))
      const erreur = await errorOf(() => emettre(id))
      assert.equal(pgErrorCode(erreur), PG_INVOICE_INVALID)
      const message = messageOf(erreur)
      assert.match(message, /SIREN du centre/)
      assert.match(message, /adresse du client/)
      assert.match(message, /IBAN du centre/)
      assert.equal((await facture(id)).status, 'draft')
    })

    it('refuse une facture vide ou négative', async () => {
      const vide = await brouillon()
      assert.equal(await errorCode(() => emettre(vide)), PG_INVOICE_INVALID)

      const negative = await brouillon()
      await ligne(negative, { kind: 'discount', description: 'Geste commercial', unitPriceCents: -500 })
      assert.equal(await errorCode(() => emettre(negative)), PG_INVOICE_INVALID)
    })

    it('n’émet que par issue_invoice : ni statut ni numéro écrits par le code', async () => {
      const id = await brouillon()
      await ligne(id)
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.update(invoices).set({ status: 'issued' }).where(eq(invoices.id, id))),
        ),
        PG_INVOICE_INVALID,
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.update(invoices).set({ number: 'FA-2026-9999' }).where(eq(invoices.id, id))),
        ),
        PG_CHECK_VIOLATION,
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.insert(invoices).values({
              clientId: DURAND,
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'issued',
            }),
          ),
        ),
        PG_INVOICE_INVALID,
      )
    })

    it('n’émet pas deux fois la même facture', async () => {
      const { id } = await factureEmise()
      assert.equal(await errorCode(() => emettre(id)), PG_INVOICE_LOCKED)
    })

    it('exige un mandat actif pour un prélèvement, et en fige la RUM', async () => {
      const id = await brouillon({ expectedPaymentMethod: 'direct_debit' })
      await ligne(id)
      assert.equal(await errorCode(() => emettre(id)), PG_INVOICE_INVALID)

      const sealed = sealIban('FR7630006000011234567890189', { tenantId: DEFAULT_TENANT_ID, reference: 'RUM-DURAND-1' }, trousseau)
      const [mandat] = await asTenant((tx) =>
        tx
          .insert(sepaMandates)
          .values({
            clientId: DURAND,
            reference: 'RUM-DURAND-1',
            debtorName: 'Atelier Durand',
            ibanCiphertext: sealed.ciphertext,
            ibanKeyVersion: sealed.keyVersion,
            ibanLast4: sealed.last4,
            signedOn: '2026-09-01',
          })
          .returning(),
      )
      await asTenant((tx) => tx.update(invoices).set({ sepaMandateId: mandat.id }).where(eq(invoices.id, id)))
      await emettre(id)
      assert.equal((await facture(id)).mandateReference, 'RUM-DURAND-1')
    })
  })

  describe('une facture émise ne se modifie plus', () => {
    it('refuse toute modification de la facture et de ses lignes (CA002)', async () => {
      const { id } = await factureEmise()
      const [premiere] = await lignes(id)
      const tentatives = [
        () => asTenant((tx) => tx.update(invoices).set({ notes: 'Corrigée' }).where(eq(invoices.id, id))),
        () => asTenant((tx) => tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, id))),
        () => asTenant((tx) => tx.update(invoices).set({ paidCents: 12_000 }).where(eq(invoices.id, id))),
        () => asTenant((tx) => tx.update(invoices).set({ deletedAt: new Date() }).where(eq(invoices.id, id))),
        () =>
          asTenant((tx) =>
            tx.update(invoiceLines).set({ unitPriceCents: 1 }).where(eq(invoiceLines.id, premiere.id)),
          ),
        () => ligne(id),
      ]
      for (const tentative of tentatives) {
        assert.equal(await errorCode(tentative), PG_INVOICE_LOCKED)
      }
      const inchangee = await facture(id)
      assert.equal(inchangee.totalInclTaxCents, 12_000)
      assert.equal(inchangee.status, 'issued')
    })

    it('ne laisse supprimer ni une facture ni une ligne', async () => {
      const { id } = await factureEmise()
      assert.equal(
        await errorCode(() => asTenant((tx) => tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id)))),
        PG_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await errorCode(() => asTenant((tx) => tx.delete(invoices).where(eq(invoices.id, id)))),
        PG_INSUFFICIENT_PRIVILEGE,
      )
      // Même le propriétaire, qui contourne les droits, est arrêté par la garde.
      assert.equal(
        await errorCode(() => owner.client`delete from invoices where id = ${id}`),
        PG_INVOICE_LOCKED,
      )
    })
  })

  describe('une source n’est facturée qu’une fois, hors avoir', () => {
    it('refuse de facturer deux fois la même réservation', async () => {
      const reservationId = await reservation()
      const premier = await brouillon()
      await ligne(premier, { kind: 'booking', bookingId: reservationId, unitPriceCents: 5_000 })
      const second = await brouillon({ periodStart: '2026-09-15', periodEnd: '2026-09-30' })
      const erreur = await errorOf(() =>
        ligne(second, { kind: 'booking', bookingId: reservationId, unitPriceCents: 5_000 }),
      )
      assert.equal(pgErrorCode(erreur), PG_UNIQUE_VIOLATION)
    })

    it('refuse de facturer deux fois le même pli', async () => {
      const acte = await service('act')
      const pli = await pliOuvert()
      const premier = await brouillon()
      await ligne(premier, { kind: 'act', serviceId: acte, mailItemId: pli, unitPriceCents: 300 })
      const second = await brouillon({ periodStart: '2026-09-02' })
      assert.equal(
        await errorCode(() => ligne(second, { kind: 'act', serviceId: acte, mailItemId: pli, unitPriceCents: 300 })),
        PG_UNIQUE_VIOLATION,
      )
    })

    it('refuse deux loyers d’un contrat sur des jours qui se recouvrent, pas sur des jours qui se suivent', async () => {
      const contratId = await contrat()
      const septembre = await brouillon()
      await ligne(septembre, {
        kind: 'rent',
        contractId: contratId,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        unitPriceCents: 90_000,
      })
      const autre = await brouillon({ periodStart: '2026-09-15', periodEnd: '2026-10-31' })
      assert.equal(
        await errorCode(() =>
          ligne(autre, {
            kind: 'rent',
            contractId: contratId,
            periodStart: '2026-09-30',
            periodEnd: '2026-10-30',
            unitPriceCents: 90_000,
          }),
        ),
        PG_EXCLUSION_VIOLATION,
      )
      await ligne(autre, {
        kind: 'rent',
        contractId: contratId,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        unitPriceCents: 90_000,
      })
    })

    it('refuse deux fois la même période d’une souscription', async () => {
      const forfait = await service('package')
      const [souscription] = await asTenant((tx) =>
        tx.execute(sql`
          insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
          values (${DURAND}, ${forfait}, 'month', 5000, 2000, '2026-01-01') returning id`),
      )
      const valeurs = {
        kind: 'package' as const,
        subscribedServiceId: souscription.id as string,
        serviceId: forfait,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        unitPriceCents: 5_000,
      }
      await ligne(await brouillon(), valeurs)
      assert.equal(
        await errorCode(async () => ligne(await brouillon({ periodStart: '2026-09-02' }), valeurs)),
        PG_EXCLUSION_VIOLATION,
      )
    })

    it('libère les sources d’un brouillon abandonné', async () => {
      const reservationId = await reservation()
      const abandonne = await brouillon()
      await ligne(abandonne, { kind: 'booking', bookingId: reservationId, unitPriceCents: 5_000 })
      await asTenant((tx) => tx.update(invoices).set({ deletedAt: new Date() }).where(eq(invoices.id, abandonne)))
      assert.deepEqual(await lignes(abandonne), [])

      await ligne(await brouillon({ periodStart: '2026-09-02' }), {
        kind: 'booking',
        bookingId: reservationId,
        unitPriceCents: 5_000,
      })
      // Abandonné, il ne se modifie plus.
      assert.equal(await errorCode(() => ligne(abandonne)), PG_INVOICE_LOCKED)
    })

    it('refuse une source d’un autre client, ou une source qui ne correspond pas à la nature', async () => {
      const reservationPetit = await reservation(PETIT)
      const id = await brouillon()
      assert.equal(
        await errorCode(() => ligne(id, { kind: 'booking', bookingId: reservationPetit, unitPriceCents: 5_000 })),
        PG_INVOICE_INVALID,
      )
      assert.equal(await errorCode(() => ligne(id, { kind: 'rent', unitPriceCents: 5_000 })), PG_INVOICE_INVALID)
      assert.equal(
        await errorCode(async () =>
          ligne(id, { kind: 'other', bookingId: await reservation(DURAND, '2026-09-11'), unitPriceCents: 1 }),
        ),
        PG_INVOICE_INVALID,
      )
    })

    it('facture chaque version d’un contrat à ses propres lignes, jamais à cheval', async () => {
      const [k] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
          values (${DURAND}, 'BUR-VERSIONS', 'bureau', '2026-01-01', 0) returning id`),
      )
      const contratId = k.id as string
      const [initiale] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contract_lines (contract_id, description, unit_price_cents)
          values (${contratId}, 'Bureau', 90000) returning id`),
      )
      await asTenant((tx) => tx.execute(sql`update contracts set status = 'active' where id = ${contratId}`))
      const [avenant] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contract_amendments (contract_id, effective_on, reason)
          values (${contratId}, '2026-07-01', 'Indexation') returning id`),
      )
      const [indexee] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contract_lines (contract_id, amendment_id, description, unit_price_cents)
          values (${contratId}, ${avenant.id as string}, 'Bureau', 92000) returning id`),
      )
      await asTenant((tx) =>
        tx.execute(sql`update contract_amendments set status = 'signed' where id = ${avenant.id as string}`),
      )

      const loyer = (lineId: string | null, periodStart: string, periodEnd: string) => async () =>
        ligne(await brouillon({ periodStart, periodEnd }), {
          kind: 'rent',
          contractId: contratId,
          contractLineId: lineId,
          periodStart,
          periodEnd,
          unitPriceCents: 90_000,
        })

      // La ligne remplacée ne se facture plus après la date d'effet…
      assert.equal(await errorCode(loyer(initiale.id as string, '2026-07-01', '2026-07-31')), PG_INVOICE_INVALID)
      // …ni une période à cheval sur la date d'effet…
      assert.equal(await errorCode(loyer(initiale.id as string, '2026-06-15', '2026-07-14')), PG_INVOICE_INVALID)
      // …ni un loyer global à côté des lignes.
      assert.equal(await errorCode(loyer(null, '2026-07-01', '2026-07-31')), PG_INVOICE_INVALID)
      // Chaque version, à ses lignes.
      await loyer(initiale.id as string, '2026-06-01', '2026-06-30')()
      await loyer(indexee.id as string, '2026-07-01', '2026-07-31')()
    })

    it('ne facture ni un contrat en brouillon, ni hors d’une souscription, ni un pli fermé', async () => {
      const [brouillonContrat] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
          values (${DURAND}, 'DOM-BROUILLON', 'domiciliation', '2026-01-01', 3000) returning id`),
      )
      assert.equal(
        await errorCode(async () =>
          ligne(await brouillon(), {
            kind: 'rent',
            contractId: brouillonContrat.id as string,
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
          }),
        ),
        PG_INVOICE_INVALID,
      )

      const forfait = await service('package')
      const [souscription] = await asTenant((tx) =>
        tx.execute(sql`
          insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on, ends_on)
          values (${DURAND}, ${forfait}, 'month', 5000, 2000, '2026-01-01', '2026-09-15') returning id`),
      )
      assert.equal(
        await errorCode(async () =>
          ligne(await brouillon(), {
            kind: 'package',
            subscribedServiceId: souscription.id as string,
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
          }),
        ),
        PG_INVOICE_INVALID,
      )

      const acte = await service('act')
      const [ferme] = await asTenant((tx) =>
        tx.execute(sql`insert into mail_items (client_id, sender) values (${DURAND}, 'Banque') returning id`),
      )
      assert.equal(
        await errorCode(async () =>
          ligne(await brouillon(), { kind: 'act', serviceId: acte, mailItemId: ferme.id as string, unitPriceCents: 300 }),
        ),
        PG_INVOICE_INVALID,
      )
    })

    it('facture une ligne ponctuelle de contrat une seule fois, au premier jour de sa version', async () => {
      const [k] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
          values (${DURAND}, 'DOM-PONCTUEL', 'domiciliation', '2026-09-01', 0) returning id`),
      )
      const [frais] = await asTenant((tx) =>
        tx.execute(sql`
          insert into contract_lines (contract_id, description, unit, unit_price_cents, is_recurring)
          values (${k.id as string}, 'Frais de dossier', 'unit', 5000, false) returning id`),
      )
      await asTenant((tx) => tx.execute(sql`update contracts set status = 'active' where id = ${k.id as string}`))
      const valeurs = {
        kind: 'package' as const,
        contractId: k.id as string,
        contractLineId: frais.id as string,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        unitPriceCents: 5_000,
      }
      const premiere = await ligne(await brouillon(), valeurs)
      assert.equal(premiere.periodStart, '2026-09-01')
      assert.equal(premiere.periodEnd, '2026-09-01')
      assert.equal(
        await errorCode(async () =>
          ligne(await brouillon({ periodStart: '2026-10-01', periodEnd: '2026-10-31' }), {
            ...valeurs,
            periodStart: '2026-10-01',
            periodEnd: '2026-10-31',
          }),
        ),
        PG_EXCLUSION_VIOLATION,
      )
    })
  })

  describe('avoirs', () => {
    it('annule une facture par un avoir lié, numéroté dans sa propre série, qui libère les sources', async () => {
      const reservationId = await reservation()
      const id = await brouillon()
      await ligne(id, { kind: 'booking', bookingId: reservationId, unitPriceCents: 5_000 })
      await ligne(id, { kind: 'discount', description: 'Remise fidélité', unitPriceCents: -500 })
      const numero = await emettre(id)

      const avoirId = await brouillonAvoir(id)
      const brouillonDAvoir = await facture(avoirId)
      assert.equal(brouillonDAvoir.kind, 'credit_note')
      assert.equal(brouillonDAvoir.creditedInvoiceId, id)
      assert.equal(brouillonDAvoir.totalInclTaxCents, (await facture(id)).totalInclTaxCents)

      const numeroAvoir = await emettre(avoirId)
      assert.equal(numeroAvoir, `AV-${ANNEE}-0001`)
      const avoir = await facture(avoirId)
      assert.equal(avoir.legalMentions?.creditedInvoiceNumber, numero)
      assert.equal(avoir.status, 'issued')

      const annulee = await facture(id)
      assert.equal(annulee.status, 'cancelled')
      assert.equal(annulee.creditedCents, annulee.totalInclTaxCents)
      for (const line of await lignes(id)) assert.ok(line.releasedAt, line.description)

      // La réservation peut être facturée à nouveau, sur la facture corrigée.
      await ligne(await brouillon({ periodStart: '2026-09-02' }), {
        kind: 'booking',
        bookingId: reservationId,
        unitPriceCents: 4_000,
      })
    })

    it('crédite partiellement, puis refuse un avoir qui dépasserait le reste', async () => {
      const { id } = await factureEmise()
      const avoirId = await brouillonAvoir(id, 'Geste commercial')
      const [reprise] = await lignes(avoirId)
      await asTenant((tx) =>
        tx.update(invoiceLines).set({ unitPriceCents: 2_500 }).where(eq(invoiceLines.id, reprise.id)),
      )
      await emettre(avoirId)
      const partielle = await facture(id)
      assert.equal(partielle.creditedCents, 3_000)
      assert.equal(partielle.status, 'issued')
      // Crédité en partie : la ligne garde sa source.
      assert.equal((await lignes(id))[0].releasedAt, null)

      // Le reste dû, payé, solde la facture.
      await payer(id, 9_000)
      assert.equal((await facture(id)).status, 'paid')

      const excessif = await brouillonAvoir(id)
      const [ligneExcessive] = await lignes(excessif)
      await asTenant((tx) =>
        tx.update(invoiceLines).set({ unitPriceCents: 9_000 }).where(eq(invoiceLines.id, ligneExcessive.id)),
      )
      assert.equal(await errorCode(() => emettre(excessif)), PG_INVOICE_INVALID)
    })

    it('ne corrige qu’une facture émise, et une ligne d’avoir ne porte pas de source', async () => {
      const brouillonId = await brouillon()
      await ligne(brouillonId)
      assert.equal(await errorCode(() => brouillonAvoir(brouillonId)), PG_INVOICE_INVALID)

      const { id } = await factureEmise()
      const avoirId = await brouillonAvoir(id)
      assert.equal(
        await errorCode(async () => ligne(avoirId, { kind: 'booking', bookingId: await reservation() })),
        PG_INVOICE_INVALID,
      )
    })
  })

  describe('statut de paiement déduit', () => {
    it('passe de émise à partiellement payée puis payée, et revient si un paiement est annulé', async () => {
      const { id } = await factureEmise()
      await payer(id, 2_000)
      assert.equal((await facture(id)).status, 'partially_paid')
      const solde = await payer(id, 10_000)
      const payee = await facture(id)
      assert.equal(payee.status, 'paid')
      assert.equal(payee.paidCents, 12_000)

      await asTenant((tx) =>
        tx
          .update(payments)
          .set({ cancelledAt: new Date(), cancelledBy: ACCUEIL, cancellationReason: 'Virement rejeté' })
          .where(eq(payments.id, solde.id)),
      )
      const rouverte = await facture(id)
      assert.equal(rouverte.status, 'partially_paid')
      assert.equal(rouverte.paidCents, 2_000)
    })

    it('refuse un paiement sur un brouillon, un avoir, ou dans une autre devise', async () => {
      const brouillonId = await brouillon()
      await ligne(brouillonId)
      assert.equal(await errorCode(() => payer(brouillonId, 1_000)), PG_PAYMENT_REFUSED)

      const { id } = await factureEmise()
      assert.equal(await errorCode(() => payer(id, 1_000, { currency: 'USD' })), PG_PAYMENT_REFUSED)

      const avoirId = await brouillonAvoir(id)
      await emettre(avoirId)
      assert.equal(await errorCode(() => payer(avoirId, 1_000)), PG_PAYMENT_REFUSED)
    })

    it('ne laisse ni modifier ni supprimer un paiement', async () => {
      const { id } = await factureEmise()
      const paiement = await payer(id, 2_000)
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.update(payments).set({ amountCents: 12_000 }).where(eq(payments.id, paiement.id))),
        ),
        PG_PAYMENT_REFUSED,
      )
      assert.equal(
        await errorCode(() => asTenant((tx) => tx.delete(payments).where(eq(payments.id, paiement.id)))),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('tient un trop-perçu pour payé, et le remboursement en paiement négatif', async () => {
      const { id } = await factureEmise()
      await payer(id, 15_000)
      assert.equal((await facture(id)).status, 'paid')
      await payer(id, -3_000, { reference: 'Remboursement du trop-perçu' })
      const soldee = await facture(id)
      assert.equal(soldee.paidCents, 12_000)
      assert.equal(soldee.status, 'paid')
    })
  })

  describe('mandats SEPA', () => {
    const MANDAT = { tenantId: DEFAULT_TENANT_ID, reference: 'RUM-2026-0001' }
    const IBAN = 'FR7630006000011234567890189'

    const mandat = (values: Partial<typeof sepaMandates.$inferInsert> = {}) => {
      const sealed = sealIban(IBAN, MANDAT, trousseau)
      return asTenant(async (tx) => {
        const [row] = await tx
          .insert(sepaMandates)
          .values({
            clientId: DURAND,
            reference: MANDAT.reference,
            debtorName: 'Atelier Durand',
            ibanCiphertext: sealed.ciphertext,
            ibanKeyVersion: sealed.keyVersion,
            ibanLast4: sealed.last4,
            signedOn: '2026-09-01',
            ...values,
          })
          .returning()
        return row
      })
    }

    it('ne stocke jamais l’IBAN en clair, et le relit par la clé', async () => {
      const cree = await mandat()
      const [brut] = await owner.client`
        select iban_ciphertext, encode(iban_ciphertext, 'escape') as texte from sepa_mandates where id = ${cree.id}`
      const octets = brut.iban_ciphertext as Buffer
      assert.ok(!octets.includes(IBAN))
      assert.ok(!octets.includes('30006000011234567890'))
      assert.ok(!String(brut.texte).includes('30006000011234567890'))

      const [relu] = await asTenant((tx) => tx.select().from(sepaMandates).where(eq(sepaMandates.id, cree.id)))
      assert.equal(openIban(relu.ibanCiphertext, relu.ibanKeyVersion, MANDAT, trousseau), IBAN)
      assert.equal(relu.ibanLast4, '0189')
    })

    it('refuse un IBAN en clair, même déguisé', async () => {
      for (const ibanCiphertext of [Buffer.from(IBAN), Buffer.from(`CAD1${IBAN}`)]) {
        assert.equal(
          await errorCode(() => mandat({ ibanCiphertext, reference: `RUM-${ibanCiphertext.length}` })),
          PG_CHECK_VIOLATION,
        )
      }
    })

    it('fige la RUM et le débiteur, un mandat actif par client, une RUM jamais réattribuée', async () => {
      const cree = await mandat()
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.update(sepaMandates).set({ reference: 'RUM-AUTRE' }).where(eq(sepaMandates.id, cree.id))),
        ),
        PG_SEPA_MANDATE_LOCKED,
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.update(sepaMandates).set({ clientId: PETIT }).where(eq(sepaMandates.id, cree.id))),
        ),
        PG_SEPA_MANDATE_LOCKED,
      )
      assert.equal(await errorCode(() => mandat({ reference: 'RUM-2026-0002' })), PG_UNIQUE_VIOLATION)

      await asTenant((tx) =>
        tx
          .update(sepaMandates)
          .set({ status: 'revoked', revokedOn: '2026-09-30' })
          .where(eq(sepaMandates.id, cree.id)),
      )
      assert.equal(await errorCode(() => mandat({ clientId: PETIT })), PG_UNIQUE_VIOLATION)
      await mandat({ reference: 'RUM-2026-0002' })
    })
  })

  describe('plan de comptes', () => {
    it('est posé pour chaque centre, et part avec lui', async () => {
      const [ici] = await asTenant((tx) =>
        tx.execute(sql`
          select count(*)::int as n,
                 max(account_number) filter (where purpose = 'vat_collected' and vat_rate_bp = 2000) as tva20
            from accounting_accounts`),
      )
      assert.equal(ici.n, 12)
      assert.equal(ici.tva20, '445711')

      await owner.client`insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-compta')`
      const [ailleurs] = await owner.client`select count(*)::int as n from accounting_accounts where tenant_id = ${AUTRE_CENTRE}`
      assert.equal(ailleurs.n, 12)
      await owner.client`delete from tenants where id = ${AUTRE_CENTRE}`
    })

    it('refuse un compte de TVA sans taux, ou un compte de vente sans nature', async () => {
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into accounting_accounts (purpose, account_number, label)
              values ('vat_collected', '445710', 'TVA')`),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into accounting_accounts (purpose, line_kind, account_number, label)
              values ('revenue', 'rent', '706999', 'Doublon')`),
          ),
        ),
        PG_UNIQUE_VIOLATION,
      )
    })

    it('garde un journal des exports que l’application ne réécrit pas', async () => {
      const [export_] = await asTenant((tx) =>
        tx.execute(sql`
          insert into accounting_exports (period_start, period_end, file_name, file_sha256, entry_count, generated_by)
          values ('2026-09-01', '2026-09-30', 'FEC-2026-09.txt', ${'a'.repeat(64)}, 12, ${ACCUEIL})
          returning id`),
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) => tx.execute(sql`update accounting_exports set entry_count = 0 where id = ${export_.id as string}`)),
        ),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('devis figé d’une réservation (R11)', () => {
    it('calcule le montant du devis par la règle commune', async () => {
      const id = await reservation()
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select quote_amount_cents from bookings where id = ${id}`),
      )
      assert.equal(row.quote_amount_cents, 5_000)
    })

    it('refuse un devis incomplet, ou posé sur une indisponibilité', async () => {
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into bookings (resource_id, channel, starts_at, ends_at, title, quote_unit, quote_quantity)
              values (${SALLE}, 'staff', '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 'Réunion', 'hour', 1)`),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
      assert.equal(
        await errorCode(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into bookings (resource_id, kind, channel, starts_at, ends_at, title,
                                    quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                                    quote_currency, quoted_at)
              values (${SALLE}, 'unavailability', 'staff', '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z',
                      'Entretien', 'hour', 1, 2500, 2000, 'EUR', now())`),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
    })

    it('accepte l’unité semaine (R08)', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title,
                                quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                                quote_currency, quoted_at)
          values (${SALLE}, ${DURAND}, 'staff', '2026-11-02T07:00:00Z', '2026-11-07T17:00:00Z', 'Séminaire',
                  'week', 1, 50000, 2000, 'EUR', now())`),
      )
    })
  })
})
