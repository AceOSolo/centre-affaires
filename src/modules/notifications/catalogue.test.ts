import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  defaultTemplates,
  eventVariables,
  notificationCategoryDescriptions,
  notificationCategoryLabels,
  notificationEventDescriptions,
  notificationEventLabels,
} from './catalogue.ts'
import { exampleValues, placeholdersOf, renderMessage, validateTemplate } from './rendu.ts'
import { notificationCategories, notificationEvents } from './schema.ts'

/**
 * Catalogue des messages (ADR 038) : chaque événement a son nom, ses
 * variables et un texte par défaut que l'éditeur accepterait lui-même.
 */
describe('catalogue des messages', () => {
  it('nomme, décrit et dote d’un texte par défaut chaque événement', () => {
    for (const event of notificationEvents) {
      assert.ok(notificationEventLabels[event], event)
      assert.ok(notificationEventDescriptions[event], event)
      assert.ok(defaultTemplates[event].subject.trim(), event)
      assert.ok(defaultTemplates[event].body.trim(), event)
    }
  })

  it('n’a que des textes par défaut valides pour leur propre événement', () => {
    for (const event of notificationEvents) {
      assert.deepEqual(validateTemplate(event, defaultTemplates[event]), {}, event)
    }
  })

  it('déclare des variables uniques, nommées comme le rendu les lit, avec un exemple', () => {
    for (const event of notificationEvents) {
      const names = eventVariables[event].map((variable) => variable.name)
      assert.equal(new Set(names).size, names.length, event)
      for (const variable of eventVariables[event]) {
        assert.match(variable.name, /^[a-z][a-z_]*$/, `${event} ${variable.name}`)
        assert.ok(variable.label && variable.example, `${event} ${variable.name}`)
      }
      assert.ok(names.includes('centre'), `${event} : la signature cite le centre`)
    }
  })

  it('cite dans chaque texte par défaut toutes les variables obligatoires, et rien d’autre', () => {
    for (const event of notificationEvents) {
      const cited = new Set([
        ...placeholdersOf(defaultTemplates[event].subject),
        ...placeholdersOf(defaultTemplates[event].body),
      ])
      for (const name of cited) {
        assert.ok(eventVariables[event].some((variable) => variable.name === name), `${event} {{${name}}}`)
      }
    }
  })

  it('rend chaque texte par défaut sans variable restée en accolades', () => {
    for (const event of notificationEvents) {
      const { subject, body } = renderMessage(defaultTemplates[event], exampleValues(event), event)
      assert.doesNotMatch(`${subject}\n${body}`, /\{\{|\}\}/, event)
      assert.doesNotMatch(`${subject}\n${body}`, /undefined|null/, event)
    }
  })

  it('ne joint jamais de document : les messages au client le disent ou mènent à l’espace', () => {
    for (const event of ['mail_received', 'mail_scanned', 'mail_request_done', 'invoice_issued', 'inspection_to_sign'] as const) {
      assert.match(defaultTemplates[event].body, /ne contient (pas|ni) le document/, event)
    }
  })

  it('nomme et décrit chaque catégorie de préférence', () => {
    for (const category of notificationCategories) {
      assert.ok(notificationCategoryLabels[category])
      assert.ok(notificationCategoryDescriptions[category])
    }
  })
})
