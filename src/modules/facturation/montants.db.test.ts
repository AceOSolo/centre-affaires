import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
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
 * `invoice_payment_status`, `src/db/regles/50-facturation.sql`) sur une grille
 * de cas choisis pour leurs arrondis : moitiés exactes, négatifs, prorata,
 * remises. Un écart ferait annoncer à l'écran un montant que la facture
 * démentirait.
 *
 * Une quatrième épreuve compare la fonction à l'expression écrite en ligne
 * dans les colonnes générées (`lineNetAmountSql`) : MySQL interdit d'appeler
 * une fonction stockée dans une colonne générée, les deux sont donc
 * deux copies de la même règle.
 */
describe('règles d’arrondi : code et base', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  after(async () => {
    await bases.fermer()
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

  const cas = (): LineAmountInput[] => {
    const liste: LineAmountInput[] = []
    for (const quantity of quantites)
      for (const unitPriceCents of prix)
        for (const remise of remises)
          for (const prorata of proratas) liste.push({ quantity, unitPriceCents, ...remise, ...prorata })
    return liste
  }

  const lignes = async (requete: ReturnType<typeof sql>) => {
    const [rows] = (await bases.app.db.execute(requete)) as unknown as [Record<string, unknown>[]]
    return rows
  }

  it('calcule le montant net de chaque ligne comme la base', async () => {
    const liste = cas()
    const valeurs = sql.join(
      liste.map(
        (c, index) =>
          sql`ROW(${index}, ${c.quantity}, ${c.unitPriceCents}, ${c.discountBp ?? null}, ${c.discountAmountCents ?? null}, ${c.prorataNumerator ?? null}, ${c.prorataDenominator ?? null})`,
      ),
      sql`, `,
    )
    const rows = await lignes(sql`
      select line_net_amount_cents(q, p, bp, d, n, den) as net
        from (values ${valeurs}) as cas(idx, q, p, bp, d, n, den)
       order by idx`)

    assert.equal(rows.length, liste.length)
    liste.forEach((c, index) => {
      assert.equal(lineNetAmountCents(c), Number(rows[index].net), JSON.stringify(c))
    })
  })

  it('porte la même règle dans l’expression des colonnes générées', async () => {
    // Table temporaire à colonne générée par la même expression que celle de
    // `invoice_lines.net_amount_cents` (`lineNetAmountSql`).
    const { lineNetAmountSql } = await import('./schema.ts')
    const expression = lineNetAmountSql({
      quantity: 'q',
      unitPrice: 'p',
      discountBp: 'bp',
      discountCents: 'd',
      prorataNumerator: 'n',
      prorataDenominator: 'den',
    })
    const liste = cas()
    const connexion = await bases.owner.client.getConnection()
    try {
      await connexion.query('drop temporary table if exists tmp_montants')
      await connexion.query(
        `create temporary table tmp_montants (
           idx int not null primary key, q int, p int, bp int, d int, n int, den int,
           net int generated always as (${new MySqlDialect().sqlToQuery(expression).sql}) stored
         )`,
      )
      for (let debut = 0; debut < liste.length; debut += 200) {
        const lot = liste.slice(debut, debut + 200)
        await connexion.query(
          'insert into tmp_montants (idx, q, p, bp, d, n, den) values ?',
          [
            lot.map((c, index) => [
              debut + index,
              c.quantity,
              c.unitPriceCents,
              c.discountBp ?? null,
              c.discountAmountCents ?? null,
              c.prorataNumerator ?? null,
              c.prorataDenominator ?? null,
            ]),
          ],
        )
      }
      const [rows] = (await connexion.query(
        `select t.net, line_net_amount_cents(t.q, t.p, t.bp, t.d, t.n, t.den) as fonction
           from tmp_montants as t order by t.idx`,
      )) as unknown as [{ net: number; fonction: number }[]]
      assert.equal(rows.length, liste.length)
      liste.forEach((c, index) => {
        assert.equal(rows[index].net, rows[index].fonction, JSON.stringify(c))
        assert.equal(rows[index].net, lineNetAmountCents(c), JSON.stringify(c))
      })
    } finally {
      await connexion.query('drop temporary table if exists tmp_montants').catch(() => {})
      connexion.release()
    }
  })

  it('calcule la TVA comme la base', async () => {
    const bases_ = [-1_005, -33, -1, 0, 1, 5, 10, 25, 33, 99, 125, 175, 1_005, 90_001, 2_000_000_000]
    const taux = [0, 210, 550, 1_000, 2_000, 850]
    const liste = bases_.flatMap((base) => taux.map((rate) => ({ base, rate })))
    const valeurs = sql.join(
      liste.map((c, index) => sql`ROW(${index}, ${c.base}, ${c.rate})`),
      sql`, `,
    )
    const rows = await lignes(sql`
      select cast(vat_amount_cents(b, r) as char) as tva
        from (values ${valeurs}) as cas(idx, b, r)
       order by idx`)
    liste.forEach((c, index) => {
      assert.equal(String(vatAmountCents(c.base, c.rate)), rows[index].tva, JSON.stringify(c))
    })
  })

  it('déduit le statut d’une facture comme la base', async () => {
    const liste: [InvoiceKind, number, number, number][] = [
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
    for (const [kind, total, paid, credited] of liste) {
      const [row] = await lignes(sql`
        select invoice_payment_status(${kind}, ${total}, ${paid}, ${credited}) as statut`)
      assert.equal(row.statut, invoicePaymentStatus(kind, total, paid, credited), `${kind} ${total} ${paid} ${credited}`)
    }
  })
})
