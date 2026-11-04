import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { defaultTemplates } from './catalogue.ts'
import {
  audiencePhrase,
  BROADCAST_BODY_MAX,
  BROADCAST_SELECTION_MAX,
  BROADCAST_STALE_MINUTES,
  BROADCAST_SUBJECT_MAX,
  broadcastProgress,
  readBroadcastInput,
  tallyOf,
} from './diffusion-regles.ts'
import { renderMessage } from './rendu.ts'
import { notificationEventAudience, notificationEventCategory } from './schema.ts'

const A = '01a00000-0000-7000-8000-0000000d0001'
const B = '01a00000-0000-7000-8000-0000000d0002'

const read = (form: Partial<{ target: unknown; clientIds: unknown[]; subject: unknown; body: unknown }>) =>
  readBroadcastInput({
    target: 'domiciliation',
    clientIds: [],
    subject: 'Fermeture du centre',
    body: 'Le centre sera fermé le 11 novembre.',
    ...form,
  })

/** Message groupé aux clients (ADR 060) : la saisie, le bilan, l'avancement. */
describe('message aux clients : la saisie', () => {
  it('nettoie l’objet sur une ligne et le texte de ses blancs de fin', () => {
    const { input, errors } = read({ subject: '  Fermeture \n le 11  ', body: 'Bonjour   \r\nÀ bientôt  \n\n' })
    assert.deepEqual(errors, {})
    assert.equal(input.subject, 'Fermeture le 11')
    assert.equal(input.body, 'Bonjour\nÀ bientôt')
  })

  it('exige un destinataire connu, un objet et un texte', () => {
    const { errors } = read({ target: 'tout-le-monde', subject: ' ', body: '' })
    assert.ok(errors.target)
    assert.ok(errors.subject)
    assert.ok(errors.body)
  })

  it('borne l’objet et le texte, comme la base', () => {
    assert.ok(read({ subject: 'x'.repeat(BROADCAST_SUBJECT_MAX) }).errors.subject === undefined)
    assert.match(read({ subject: 'x'.repeat(BROADCAST_SUBJECT_MAX + 1) }).errors.subject ?? '', /dépasse/)
    assert.match(read({ body: 'x'.repeat(BROADCAST_BODY_MAX + 1) }).errors.body ?? '', /dépasse/)
  })

  it('refuse les doubles accolades : elles partiraient telles quelles', () => {
    assert.ok(read({ subject: 'Bonjour {{client}}' }).errors.subject)
    assert.ok(read({ body: 'Texte }} cassé' }).errors.body)
  })

  it('ne garde les entreprises cochées que pour une sélection, sans doublon ni valeur forgée', () => {
    assert.deepEqual(read({ clientIds: [A, B] }).input.clientIds, [])
    const selection = read({ target: 'selection', clientIds: [A, A, 'pas-un-id', B] })
    assert.deepEqual(selection.input.clientIds, [A, B])
    assert.deepEqual(selection.errors, {})
    assert.match(read({ target: 'selection', clientIds: [] }).errors.clients ?? '', /Cochez/)
  })

  it('borne une sélection', () => {
    const many = Array.from(
      { length: BROADCAST_SELECTION_MAX + 1 },
      (_, index) => `01a00000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    )
    assert.match(read({ target: 'selection', clientIds: many }).errors.clients ?? '', /au plus/)
  })
})

describe('message aux clients : le modèle', () => {
  it('va aux clients, et se refuse par « Informations du centre »', () => {
    assert.equal(notificationEventAudience.client_broadcast, 'client')
    assert.equal(notificationEventCategory.client_broadcast, 'centre_info')
  })

  it('entoure le texte saisi sans le réinterpréter, et dit comment ne plus le recevoir', () => {
    const rendered = renderMessage(
      defaultTemplates.client_broadcast,
      {
        centre: 'Centre Horizon',
        client: 'Atelier Exemple',
        objet: 'Travaux',
        message: 'Ligne 1\nLigne 2 avec {{centre}} écrit à la main',
        lien: 'https://centre.exemple/compte/preferences',
      },
      'Message',
    )
    assert.equal(rendered.subject, 'Travaux')
    assert.match(rendered.body, /^Bonjour,\n\nLigne 1\nLigne 2 avec \{\{centre\}\} écrit à la main\n/)
    assert.match(rendered.body, /décochez « Informations du centre »/)
    assert.match(rendered.body, /https:\/\/centre\.exemple\/compte\/preferences$/)
  })

  it('part sans lien quand l’adresse de l’application manque', () => {
    const rendered = renderMessage(
      defaultTemplates.client_broadcast,
      { centre: 'Centre Horizon', client: 'Atelier Exemple', objet: 'Travaux', message: 'Texte', lien: undefined },
      'Message',
    )
    assert.doesNotMatch(rendered.body, /\{\{|https?:/)
    assert.match(rendered.body, /préférences de votre espace client\.$/)
  })
})

describe('message aux clients : bilan et avancement', () => {
  it('additionne les entreprises et les adresses par issue', () => {
    const tally = tallyOf([
      { status: 'sent', companies: 3, addresses: 5, failedAddresses: 0 },
      { status: 'failed', companies: 1, addresses: 2, failedAddresses: 1 },
      { status: 'skipped', companies: 2, addresses: 0, failedAddresses: 0 },
      { status: 'pending', companies: 4, addresses: 0, failedAddresses: 0 },
    ])
    assert.deepEqual(tally, {
      companies: 10,
      pending: 4,
      sent: 3,
      failed: 1,
      notConfigured: 0,
      skipped: 2,
      addresses: 7,
      failedAddresses: 1,
    })
  })

  it('dit terminé, en cours, ou interrompu passé le délai de reprise', () => {
    const now = new Date('2026-11-04T10:00:00Z')
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
    assert.equal(broadcastProgress({ pending: 0 }, minutesAgo(60), now), 'done')
    assert.equal(broadcastProgress({ pending: 3 }, minutesAgo(1), now), 'running')
    assert.equal(broadcastProgress({ pending: 3 }, minutesAgo(BROADCAST_STALE_MINUTES + 1), now), 'stalled')
    assert.equal(broadcastProgress({ pending: 3 }, null, now), 'stalled')
  })

  it('annonce les destinataires au singulier comme au pluriel', () => {
    assert.equal(audiencePhrase({ companies: 1, people: 1 }), '1 entreprise, 1 personne')
    assert.equal(audiencePhrase({ companies: 12, people: 18 }), '12 entreprises, 18 personnes')
  })
})
