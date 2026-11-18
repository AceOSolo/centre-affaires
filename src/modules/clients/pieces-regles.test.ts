import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canDepositAfter,
  canReview,
  checkDocumentBytes,
  defaultDocumentKinds,
  describeKinds,
  detectDocumentType,
  documentChecklist,
  isHeif,
  kindsForSituation,
  missingCount,
  moveKind,
  newKindCode,
  parseKindInput,
  parseRefusalReason,
  readDocumentFiles,
  situationFromAnswers,
  toReviewCount,
  type ClientDocumentKind,
  type DepositedDocument,
} from './pieces-regles.ts'

/**
 * Pièces justificatives de la domiciliation (ADR 075) : ce qui est demandé
 * selon la situation de la société, où en est le client, ce que l'accueil
 * peut faire, et le contrôle des fichiers reçus.
 */

const codes = (kinds: readonly ClientDocumentKind[]) => kinds.map((kind) => kind.code)

/** Un JPEG minimal lisible par `readJpegInfo` : SOI, SOF0 (2 × 3, couleurs), EOI. */
function jpeg(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03,
    0x11, 0x01, 0xff, 0xd9,
  ])
}
const pdf = () => new TextEncoder().encode('%PDF-1.7\n%%EOF\n')
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const heic = () => new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])
const html = () => new TextEncoder().encode('<html><script>alert(1)</script></html>')

describe('pièces demandées selon la situation de la société', () => {
  it('lit la situation dans les réponses de la demande de domiciliation, transfert compris', () => {
    assert.equal(situationFromAnswers({ situation: 'creation' }), 'creation')
    assert.equal(situationFromAnswers({ situation: 'immatriculee' }), 'registered')
    // Le transfert de siège est une société déjà immatriculée (lot 1 : deux choix seulement).
    assert.equal(situationFromAnswers({ situation: 'transfert' }), 'registered')
    assert.equal(situationFromAnswers({}), null)
    assert.equal(situationFromAnswers(null), null)
  })

  it('demande les statuts en création, le Kbis une fois immatriculée, l’identité et le domicile toujours', () => {
    assert.deepEqual(codes(kindsForSituation(defaultDocumentKinds, 'creation')), [
      'piece-identite',
      'statuts',
      'justificatif-domicile',
    ])
    assert.deepEqual(codes(kindsForSituation(defaultDocumentKinds, 'registered')), [
      'piece-identite',
      'kbis',
      'justificatif-domicile',
    ])
  })

  it('tient une société sans situation connue pour immatriculée', () => {
    assert.deepEqual(codes(kindsForSituation(defaultDocumentKinds, null)), codes(kindsForSituation(defaultDocumentKinds, 'registered')))
  })

  it('ne demande pas une pièce retirée de la liste, et suit l’ordre du centre', () => {
    const kinds = defaultDocumentKinds.map((kind) =>
      kind.code === 'kbis' ? { ...kind, active: false } : kind.code === 'piece-identite' ? { ...kind, position: 9 } : kind,
    )
    assert.deepEqual(codes(kindsForSituation(kinds, 'registered')), ['justificatif-domicile', 'piece-identite'])
  })

  it('dit la liste dans une phrase, pour l’accusé de réception', () => {
    assert.equal(
      describeKinds(kindsForSituation(defaultDocumentKinds, 'registered')),
      'pièce d’identité du dirigeant, extrait Kbis et justificatif de domicile du dirigeant',
    )
    assert.equal(describeKinds([{ label: 'Extrait Kbis' }]), 'extrait Kbis')
    assert.equal(describeKinds([]), '')
  })
})

describe('liste réglée dans l’admin', () => {
  it('exige un nom et une situation connue, borne l’aide', () => {
    assert.deepEqual(parseKindInput({ label: '  Attestation   URSSAF ', help: '', appliesTo: 'registered' }), {
      ok: true,
      value: { label: 'Attestation URSSAF', help: null, appliesTo: 'registered' },
    })
    const refus = parseKindInput({ label: ' ', help: 'x'.repeat(301), appliesTo: 'toutes' })
    assert.equal(refus.ok, false)
    assert.deepEqual(Object.keys(refus.ok ? {} : refus.errors).sort(), ['appliesTo', 'help', 'label'])
  })

  it('tire le code d’une nouvelle pièce de son nom, libre dans la liste', () => {
    assert.equal(newKindCode('Attestation URSSAF', []), 'attestation-urssaf')
    assert.equal(newKindCode('Extrait Kbis', ['extrait-kbis']), 'extrait-kbis-2')
    assert.equal(newKindCode('!!!', []), 'piece')
    assert.match(newKindCode('x'.repeat(80), []), /^[a-z0-9-]{1,40}$/)
  })

  it('monte et descend une pièce, sans sortir de la liste', () => {
    assert.deepEqual(moveKind(['a', 'b', 'c'], 'b', 'up'), ['b', 'a', 'c'])
    assert.deepEqual(moveKind(['a', 'b', 'c'], 'b', 'down'), ['a', 'c', 'b'])
    assert.deepEqual(moveKind(['a', 'b', 'c'], 'a', 'up'), ['a', 'b', 'c'])
    assert.deepEqual(moveKind(['a', 'b', 'c'], 'z', 'down'), ['a', 'b', 'c'])
  })
})

describe('où en est le client', () => {
  const kinds = kindsForSituation(defaultDocumentKinds, 'registered')
  const depot = (kindCode: string, status: DepositedDocument['status'], day: number): DepositedDocument => ({
    id: `${kindCode}-${day}`,
    kindCode,
    kindLabel: kindCode,
    status,
    refusalReason: status === 'refused' ? 'Illisible.' : null,
    contentType: 'application/pdf',
    byteSize: 1000,
    createdAt: new Date(Date.UTC(2026, 10, day)),
    reviewedAt: status === 'received' ? null : new Date(Date.UTC(2026, 10, day + 1)),
    purged: false,
  })

  it('prend la dernière pièce déposée pour chaque type ; la plus ancienne reste dans l’historique', () => {
    const { items, others } = documentChecklist(kinds, [
      depot('kbis', 'refused', 2),
      depot('kbis', 'received', 5),
      depot('piece-identite', 'accepted', 3),
      depot('statuts', 'received', 4),
    ])
    assert.deepEqual(
      items.map((item) => [item.kind.code, item.state, item.canDeposit, item.history.length]),
      [
        ['piece-identite', 'accepted', false, 1],
        ['kbis', 'received', false, 2],
        ['justificatif-domicile', 'missing', true, 0],
      ],
    )
    // Les statuts ne sont plus demandés à une société immatriculée : à part.
    assert.deepEqual(others.map((document) => document.kindCode), ['statuts'])
    assert.equal(missingCount(items), 1)
    assert.equal(toReviewCount(items), 1)
  })

  it('laisse redéposer une pièce refusée, pas une pièce en attente ou validée', () => {
    assert.equal(canDepositAfter('missing'), true)
    assert.equal(canDepositAfter('refused'), true)
    assert.equal(canDepositAfter('received'), false)
    assert.equal(canDepositAfter('accepted'), false)
    const { items } = documentChecklist(kinds, [depot('kbis', 'refused', 2)])
    assert.equal(items.find((item) => item.kind.code === 'kbis')?.canDeposit, true)
    assert.equal(missingCount(items), 3)
  })
})

describe('vérification par l’accueil', () => {
  it('valide ou refuse une pièce reçue ; une pièce validée peut encore être refusée, jamais l’inverse', () => {
    assert.equal(canReview('received', 'accepted'), true)
    assert.equal(canReview('received', 'refused'), true)
    assert.equal(canReview('accepted', 'refused'), true)
    assert.equal(canReview('refused', 'accepted'), false)
    assert.equal(canReview('accepted', 'accepted'), false)
  })

  it('exige un motif de refus, lu par le client, et le borne', () => {
    assert.deepEqual(parseRefusalReason('  Kbis de plus de trois mois. '), { ok: true, reason: 'Kbis de plus de trois mois.' })
    assert.equal(parseRefusalReason('   ').ok, false)
    assert.equal(parseRefusalReason(null).ok, false)
    assert.equal(parseRefusalReason('x'.repeat(501)).ok, false)
  })
})

describe('fichiers reçus', () => {
  it('lit le type dans les octets : PDF, JPEG, PNG ; rien d’autre', () => {
    assert.equal(detectDocumentType(pdf()), 'application/pdf')
    assert.equal(detectDocumentType(jpeg()), 'image/jpeg')
    assert.equal(detectDocumentType(png()), 'image/png')
    assert.equal(detectDocumentType(html()), undefined)
  })

  it('reconnaît une photo HEIC d’iPhone et dit quoi faire', () => {
    assert.equal(isHeif(heic()), true)
    assert.equal(isHeif(jpeg()), false)
    const refus = checkDocumentBytes([heic()])
    assert.match(refus.error ?? '', /HEIC/)
  })

  it('garde un PDF, une photo ou une image seuls ; refuse un HTML déguisé', () => {
    assert.equal(checkDocumentBytes([pdf()]).file?.contentType, 'application/pdf')
    assert.equal(checkDocumentBytes([png()]).file?.contentType, 'image/png')
    assert.equal(checkDocumentBytes([jpeg()]).file?.contentType, 'image/jpeg')
    assert.match(checkDocumentBytes([html()]).error ?? '', /PDF, JPEG et PNG/)
    assert.match(checkDocumentBytes([]).error ?? '', /Choisissez/)
  })

  it('réunit plusieurs photos JPEG — recto et verso — en un seul PDF', () => {
    const result = checkDocumentBytes([jpeg(), jpeg()])
    assert.equal(result.file?.contentType, 'application/pdf')
    assert.equal(detectDocumentType(result.file?.bytes ?? new Uint8Array()), 'application/pdf')
  })

  it('refuse plusieurs fichiers qui ne sont pas tous des photos JPEG', () => {
    assert.match(checkDocumentBytes([pdf(), jpeg()]).error ?? '', /photos JPEG/)
  })

  it('ignore les champs vides et plafonne le nombre et le poids des fichiers', async () => {
    const vide = new File([], 'vide.pdf')
    assert.match((await readDocumentFiles([vide, 'texte'])).error ?? '', /Choisissez/)
    const trop = Array.from({ length: 21 }, (_, index) => new File([jpeg()], `p${index}.jpg`))
    assert.match((await readDocumentFiles(trop)).error ?? '', /Au plus 20 photos/)
    const lourd = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'lourd.pdf')
    assert.match((await readDocumentFiles([lourd])).error ?? '', /10 Mo/)
    assert.equal((await readDocumentFiles([new File([pdf()], 'kbis.pdf')])).file?.contentType, 'application/pdf')
  })
})
