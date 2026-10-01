import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase } from '../../db/index.ts'
import {
  invoicePaymentStatus,
  lineNetAmountCents,
  vatAmountCents,
  type LineAmountInput,
} from './montants.ts'
import type { InvoiceKind } from './schema-factures.ts'

/**
 * Les jumeaux TypeScript des règles d'arrondi (`montants.ts`) tombent au même
 * centime que la base (`line_net_amount_cents`, `vat_amount_cents`,
 * `invoice_payment_status`, migrations 0029 et 0031) sur une grille de cas
 * choisis pour leurs arrondis : moitiés exactes, négatifs, prorata, remises.
 * Un écart ferait annoncer à l'écran un montant que la facture démentirait.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('règles d’arrondi : code et base', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  const quantites = [1, 2, 3, 7]
  const prix = [0, 1, 33, 99, 125, 2_500, 9_000, 90_001, -125, -999]
  const remises: Pick<LineAmountInput, 'discountBp' | 'discountAmountCents'>[] = [
    {},
    { discountBp: 1_000 },
    { discountBp: 1_250 },
    { discountBp: 3_333 },
    { discountBp: 5_000 },
    { discountAmountCents: 1 },
    { discountAmountCents: 500 },
  ]
  const proratas: Pick<LineAmountInput, 'prorataNumerator' | 'prorataDenominator'>[] = [
    {},
    { prorataNumerator: 22, prorataDenominator: 31 },
    { prorataNumerator: 15, prorataDenominator: 30 },
    { prorataNumerator: 1, prorataDenominator: 3 },
    { prorataNumerator: 59, prorataDenominator: 90 },
  ]

  it('calcule le montant net de chaque ligne comme la base', async () => {
    const cas: LineAmountInput[] = []
    for (const quantity of quantites)
      for (const unitPriceCents of prix)
        for (const remise of remises)
          for (const prorata of proratas) cas.push({ quantity, unitPriceCents, ...remise, ...prorata })

    const valeurs = sql.join(
      cas.map(
        (c) =>
          sql`(${c.quantity}::int, ${c.unitPriceCents}::int, ${c.discountBp ?? null}::int, ${c.discountAmountCents ?? null}::int, ${c.prorataNumerator ?? null}::int, ${c.prorataDenominator ?? null}::int)`,
      ),
      sql`, `,
    )
    const rows = await app.db.execute(sql`
      select line_net_amount_cents(q, p, bp, d, n, den) as net
        from (values ${valeurs}) as cas(q, p, bp, d, n, den)`)

    assert.equal(rows.length, cas.length)
    cas.forEach((c, index) => {
      assert.equal(lineNetAmountCents(c), rows[index].net, JSON.stringify(c))
    })
  })

  it('calcule la TVA comme la base', async () => {
    const bases = [-1_005, -33, -1, 0, 1, 5, 10, 25, 33, 99, 125, 175, 1_005, 90_001, 2_000_000_000]
    const taux = [0, 210, 550, 1_000, 2_000, 850]
    const cas = bases.flatMap((base) => taux.map((rate) => ({ base, rate })))
    const valeurs = sql.join(
      cas.map((c) => sql`(${c.base}::bigint, ${c.rate}::int)`),
      sql`, `,
    )
    const rows = await app.db.execute(sql`
      select vat_amount_cents(b, r)::text as tva from (values ${valeurs}) as cas(b, r)`)
    cas.forEach((c, index) => {
      assert.equal(String(vatAmountCents(c.base, c.rate)), rows[index].tva, JSON.stringify(c))
    })
  })

  it('déduit le statut d’une facture comme la base', async () => {
    const cas: [InvoiceKind, number, number, number][] = [
      ['invoice', 12_000, 0, 0],
      ['invoice', 12_000, 1, 0],
      ['invoice', 12_000, 11_999, 0],
      ['invoice', 12_000, 12_000, 0],
      ['invoice', 12_000, 20_000, 0],
      ['invoice', 12_000, -500, 0],
      ['invoice', 12_000, 0, 6_000],
      ['invoice', 12_000, 6_000, 6_000],
      ['invoice', 12_000, 0, 12_000],
      ['invoice', 12_000, 12_000, 12_000],
      ['invoice', 0, 0, 0],
      ['credit_note', 12_000, 0, 0],
    ]
    for (const [kind, total, paid, credited] of cas) {
      const [row] = await app.db.execute(sql`
        select invoice_payment_status(${kind}::invoice_kind, ${total}::int, ${paid}::int, ${credited}::int) as statut`)
      assert.equal(row.statut, invoicePaymentStatus(kind, total, paid, credited), `${kind} ${total} ${paid} ${credited}`)
    }
  })
})
