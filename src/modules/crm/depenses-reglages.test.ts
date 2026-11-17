import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_EXPENSE_NOTE,
  defaultExpenseSettings,
  readExpenseSettings,
  readExpenseSettingsForm,
} from './depenses-reglages.ts'

/** Réglages de « Mes dépenses » (ADR 081) : valeurs par défaut, ligne relue, formulaire. */

const formulaire = (valeurs: Record<string, string>) => {
  const form = new FormData()
  for (const [name, value] of Object.entries(valeurs)) form.set(name, value)
  return form
}

describe('réglages des dépenses : valeurs', () => {
  it('sans réglage, rien à faire : dépenses montrées, actes estimés, douze mois, phrase par défaut', () => {
    assert.deepEqual(readExpenseSettings(undefined), {
      showExpenses: true,
      estimateMailActs: true,
      historyMonths: 12,
      note: DEFAULT_EXPENSE_NOTE,
      customNote: false,
    })
    assert.deepEqual(readExpenseSettings(undefined), defaultExpenseSettings)
  })

  it('relit la ligne du centre ; une phrase nulle revient à celle par défaut', () => {
    assert.deepEqual(
      readExpenseSettings({ showExpenses: false, estimateMailActs: false, historyMonths: 6, note: 'Facturé le 1er du mois suivant.' }),
      { showExpenses: false, estimateMailActs: false, historyMonths: 6, note: 'Facturé le 1er du mois suivant.', customNote: true },
    )
    assert.equal(readExpenseSettings({ showExpenses: true, estimateMailActs: true, historyMonths: 12, note: null }).note, DEFAULT_EXPENSE_NOTE)
  })
})

describe('réglages des dépenses : formulaire', () => {
  it('une case décochée est absente du formulaire : faux', () => {
    const read = readExpenseSettingsForm(formulaire({ historyMonths: '24', note: '' }))
    assert.deepEqual(read, {
      ok: true,
      value: { showExpenses: false, estimateMailActs: false, historyMonths: 24, note: null },
    })
  })

  it('garde la phrase du centre, sur une ligne ; la phrase par défaut n’est pas recopiée', () => {
    const read = readExpenseSettingsForm(
      formulaire({ showExpenses: 'on', estimateMailActs: 'on', historyMonths: '12', note: '  Facturé le 1er\ndu mois suivant. ' }),
    )
    assert.deepEqual(read, {
      ok: true,
      value: { showExpenses: true, estimateMailActs: true, historyMonths: 12, note: 'Facturé le 1er du mois suivant.' },
    })
    const parDefaut = readExpenseSettingsForm(formulaire({ historyMonths: '12', note: DEFAULT_EXPENSE_NOTE }))
    assert.equal(parDefaut.ok && parDefaut.value.note, null)
  })

  it('refuse une durée hors de la liste et une phrase trop longue', () => {
    const read = readExpenseSettingsForm(formulaire({ historyMonths: '7', note: 'x'.repeat(301) }))
    assert.equal(read.ok, false)
    assert.deepEqual(Object.keys((read as { fieldErrors: object }).fieldErrors), ['historyMonths', 'note'])
  })
})
