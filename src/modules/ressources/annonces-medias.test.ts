import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  checkListingMedia,
  coverPhoto,
  describeListingMedia,
  detectVideo,
  LISTING_MEDIA_ALT_MAX,
  LISTING_PHOTO_MAX_BYTES,
  LISTING_VIDEO_MAX_BYTES,
  listingMediaAlt,
  listingMediaKey,
  moveListingMedia,
  parseListingMedia,
  singleByteRange,
  withoutListingMedia,
  type ListingMedia,
} from './annonces-medias.ts'

/**
 * Photos et vidéos des annonces (ADR 073) : type lu dans les octets, tailles
 * bornées, ordre d'affichage tenu par le centre.
 */

function jpeg(width: number, height: number, size = 39): Uint8Array {
  const head = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]
  const bytes = new Uint8Array(Math.max(size, head.length))
  bytes.set(head)
  return bytes
}

function mp4(brand = 'isom', size = 32): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x00, 0x00, 0x00, 0x20])
  bytes.set([...'ftyp', ...brand].map((char) => char.charCodeAt(0)), 4)
  return bytes
}

function webm(docType = 'webm'): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84])
  bytes.set([...docType].map((char) => char.charCodeAt(0)), 12)
  return bytes
}

const media = (id: string, kind: ListingMedia['kind'] = 'photo'): ListingMedia => ({
  id,
  kind,
  contentType: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
  key: `annonces/t/l/${id}`,
  byteSize: 10,
  width: kind === 'photo' ? 1920 : null,
  height: kind === 'photo' ? 1080 : null,
  alt: null,
})

describe('médias d’annonce : contrôle du fichier', () => {
  it('reconnaît une photo à ses octets et en lit les dimensions', () => {
    const { media: lu, error } = checkListingMedia(jpeg(1920, 1280))
    assert.equal(error, undefined)
    assert.equal(lu?.kind, 'photo')
    assert.equal(lu?.contentType, 'image/jpeg')
    assert.equal(lu?.width, 1920)
    assert.equal(lu?.height, 1280)
  })

  it('reconnaît une vidéo MP4 et une vidéo WebM', () => {
    assert.deepEqual(detectVideo(mp4()), { contentType: 'video/mp4' })
    assert.deepEqual(detectVideo(mp4('mp42')), { contentType: 'video/mp4' })
    assert.deepEqual(detectVideo(webm()), { contentType: 'video/webm' })
    assert.equal(checkListingMedia(mp4()).media?.kind, 'video')
  })

  it('refuse une vidéo QuickTime en disant comment faire', () => {
    assert.equal(detectVideo(mp4('qt  ')), 'quicktime')
    assert.match(checkListingMedia(mp4('qt  ')).error ?? '', /MP4/)
  })

  it('refuse un Matroska qui n’est pas un WebM', () => {
    assert.equal(detectVideo(webm('matroska')), undefined)
    assert.ok(checkListingMedia(webm('matroska')).error)
  })

  it('refuse ce qui n’est ni une image ni une vidéo, même nommé .jpg', () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    assert.match(checkListingMedia(html).error ?? '', /JPEG/)
  })

  it('borne la photo à 10 Mo et la vidéo à 20 Mo', () => {
    assert.ok(checkListingMedia(jpeg(100, 100, LISTING_PHOTO_MAX_BYTES)).media)
    assert.match(checkListingMedia(jpeg(100, 100, LISTING_PHOTO_MAX_BYTES + 1)).error ?? '', /10 Mo/)
    assert.ok(checkListingMedia(mp4('isom', LISTING_VIDEO_MAX_BYTES)).media)
    assert.match(checkListingMedia(mp4('isom', LISTING_VIDEO_MAX_BYTES + 1)).error ?? '', /20 Mo/)
  })

  it('refuse une photo aux dimensions nulles', () => {
    assert.ok(checkListingMedia(jpeg(0, 100)).error)
  })
})

describe('médias d’annonce : rangement', () => {
  it('range le fichier par centre et par annonce, avec l’extension du type lu', () => {
    assert.equal(listingMediaKey('t1', 'l1', 'm1', 'video/webm'), 'annonces/t1/l1/m1.webm')
  })

  it('écarte de la colonne ce qui n’est pas un média', () => {
    assert.deepEqual(parseListingMedia(null), [])
    assert.deepEqual(parseListingMedia(['annonces/ancienne-cle.jpg']), [])
    assert.deepEqual(parseListingMedia([media('a'), { id: 'b' }]), [media('a')])
  })
})

describe('médias d’annonce : ordre et description', () => {
  const list = [media('a'), media('b'), media('c')]
  const ids = (items: ListingMedia[]) => items.map((item) => item.id).join('')

  it('avance, recule et met en premier sans déranger les autres', () => {
    assert.equal(ids(moveListingMedia(list, 'b', 'earlier')), 'bac')
    assert.equal(ids(moveListingMedia(list, 'b', 'later')), 'acb')
    assert.equal(ids(moveListingMedia(list, 'c', 'first')), 'cab')
  })

  it('ne bouge rien aux bords ni pour un média inconnu', () => {
    assert.equal(ids(moveListingMedia(list, 'a', 'earlier')), 'abc')
    assert.equal(ids(moveListingMedia(list, 'c', 'later')), 'abc')
    assert.equal(ids(moveListingMedia(list, 'z', 'first')), 'abc')
  })

  it('retire un média', () => {
    assert.equal(ids(withoutListingMedia(list, 'b')), 'ac')
  })

  it('nettoie et borne la description ; vide, elle disparaît', () => {
    const [first] = describeListingMedia(list, 'a', '  Vue   sur cour  ')
    assert.equal(first.alt, 'Vue sur cour')
    assert.equal(describeListingMedia(list, 'a', '   ')[0].alt, null)
    assert.equal(describeListingMedia(list, 'a', 'x'.repeat(500))[0].alt?.length, LISTING_MEDIA_ALT_MAX)
  })

  it('prend la première photo comme couverture, jamais une vidéo', () => {
    assert.equal(coverPhoto([media('v', 'video'), media('p')])?.id, 'p')
    assert.equal(coverPhoto([media('v', 'video')]), undefined)
  })

  it('donne à chaque média un texte alternatif', () => {
    assert.equal(listingMediaAlt(media('a'), 'Salle Mont Blanc', 1, 3), 'Photo 2 sur 3 — Salle Mont Blanc')
    assert.equal(listingMediaAlt(media('v', 'video'), 'Salle', 0, 1), 'Vidéo — Salle')
    assert.equal(listingMediaAlt({ ...media('a'), alt: 'La terrasse' }, 'Salle', 0, 3), 'La terrasse')
  })
})

describe('médias d’annonce : plages d’octets', () => {
  it('accepte une seule plage, et rien d’autre', () => {
    assert.equal(singleByteRange('bytes=0-'), 'bytes=0-')
    assert.equal(singleByteRange('bytes=100-200'), 'bytes=100-200')
    assert.equal(singleByteRange('bytes=-500'), 'bytes=-500')
    assert.equal(singleByteRange('bytes=0-1,5-9'), undefined)
    assert.equal(singleByteRange('items=0-1'), undefined)
    assert.equal(singleByteRange(null), undefined)
  })
})
