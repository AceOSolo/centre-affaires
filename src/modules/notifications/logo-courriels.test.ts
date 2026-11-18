import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  checkEmailLogo,
  EMAIL_LOGO_MAX_BYTES,
  emailLogoHeaders,
  emailLogoKey,
  emailLogoPath,
  logoDisplaySize,
  parseEmailLogoFile,
  svgSize,
  unsafeSvg,
} from './logo-courriels.ts'

/**
 * Logo des courriels (ADR 080) : type lu dans les octets, SVG sans contenu
 * actif, rangement, adresse publique, taille dans l'en-tête.
 */

/** En-tête PNG minimal : signature, bloc IHDR avec largeur et hauteur. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

/** JPEG minimal : SOI, puis un SOF0 qui porte hauteur et largeur. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03])
  new DataView(bytes.buffer).setUint16(7, height)
  new DataView(bytes.buffer).setUint16(9, width)
  return bytes
}

const text = (value: string) => new TextEncoder().encode(value)
const svg = (attributes: string, body = '<path d="M0 0h10v10z"/>') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Logo -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attributes}>${body}</svg>`

describe('fichier du logo', () => {
  it('accepte un PNG et un JPEG, dimensions lues dans les octets', () => {
    assert.deepEqual(checkEmailLogo(png(600, 191)).logo, { contentType: 'image/png', width: 600, height: 191 })
    assert.deepEqual(checkEmailLogo(jpeg(400, 100)).logo, { contentType: 'image/jpeg', width: 400, height: 100 })
  })

  it('accepte un SVG, dimensions lues dans sa viewBox ou ses attributs', () => {
    assert.deepEqual(checkEmailLogo(text(svg('viewBox="0 0 300 100"'))).logo, {
      contentType: 'image/svg+xml',
      width: 300,
      height: 100,
    })
    assert.deepEqual(svgSize(svg('width="240px" height="80" stroke-width="2"')), { width: 240, height: 80 })
    // Des millimètres ne disent rien des pixels : la viewBox l'emporte.
    assert.deepEqual(svgSize(svg('width="60mm" height="20mm" viewBox="0,0,600,200"')), { width: 600, height: 200 })
  })

  it('refuse un SVG sans dimensions lisibles', () => {
    assert.match(checkEmailLogo(text(svg(''))).error ?? '', /viewBox/)
  })

  it('refuse un SVG qui exécute ou appelle quelque chose', () => {
    const pieges = [
      svg('viewBox="0 0 10 10"', '<script>alert(1)</script>'),
      svg('viewBox="0 0 10 10" onload="alert(1)"'),
      svg('viewBox="0 0 10 10"', '<a href="javascript:alert(1)"><path d="M0 0"/></a>'),
      svg('viewBox="0 0 10 10"', '<image href="https://traceur.exemple/pixel.png"/>'),
      svg('viewBox="0 0 10 10"', '<image xlink:href="//traceur.exemple/pixel.png"/>'),
      svg('viewBox="0 0 10 10"', '<foreignObject><div>x</div></foreignObject>'),
      svg('viewBox="0 0 10 10"', '<style>@import url(https://polices.exemple/a.css);</style>'),
      svg('viewBox="0 0 10 10"', '<path style="fill:url(https://x.exemple/#a)" d="M0 0"/>'),
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 10 10"></svg>',
    ]
    for (const piege of pieges) assert.ok(checkEmailLogo(text(piege)).error, piege)
  })

  it('accepte une image intégrée et un renvoi interne', () => {
    const sain = svg(
      'viewBox="0 0 10 10"',
      '<defs><linearGradient id="d"/></defs><path fill="url(#d)" d="M0 0"/><use href="#d"/>' +
        '<image href="data:image/png;base64,iVBORw0KGgo="/>',
    )
    assert.equal(unsafeSvg(sain), false)
    assert.ok(checkEmailLogo(text(sain)).logo)
  })

  it('refuse le WebP, que n’affiche pas Outlook, et tout autre fichier', () => {
    const webp = new Uint8Array(30)
    webp.set(text('RIFF'), 0)
    webp.set(text('WEBPVP8X'), 8)
    assert.match(checkEmailLogo(webp).error ?? '', /WebP/)
    assert.match(checkEmailLogo(text('%PDF-1.7')).error ?? '', /PNG, JPEG ou SVG/)
    assert.match(checkEmailLogo(text('<html><svg></svg></html>')).error ?? '', /PNG, JPEG ou SVG/)
  })

  it('refuse un fichier vide ou de plus d’1 Mo', () => {
    assert.match(checkEmailLogo(new Uint8Array()).error ?? '', /Aucun fichier/)
    const lourd = new Uint8Array(EMAIL_LOGO_MAX_BYTES + 1)
    lourd.set(png(600, 191))
    assert.match(checkEmailLogo(lourd).error ?? '', /1 Mo/)
  })

  it('refuse un PNG aux dimensions nulles', () => {
    assert.ok(checkEmailLogo(png(0, 191)).error)
  })
})

describe('rangement et adresse du logo', () => {
  const ID = '019a8f00-0000-7000-8000-00000000a001'
  const CENTRE = '01999f00-0000-7000-8000-000000000001'

  it('range le logo par centre, et le sert sous son identifiant', () => {
    assert.equal(emailLogoKey(CENTRE, ID, 'image/png'), `centre/${CENTRE}/logo-courriels/${ID}.png`)
    assert.equal(emailLogoPath({ id: ID, contentType: 'image/svg+xml' }), `/medias/centre/logo/${ID}.svg`)
  })

  it('relit le nom de fichier de l’adresse, et rien d’autre', () => {
    assert.deepEqual(parseEmailLogoFile(`${ID}.png`), { id: ID, contentType: 'image/png' })
    assert.deepEqual(parseEmailLogoFile(`${ID.toUpperCase()}.JPG`), { id: ID, contentType: 'image/jpeg' })
    for (const nom of [`${ID}.webp`, `${ID}.png.html`, '../secret.png', 'logo.png', `${ID}`]) {
      assert.equal(parseEmailLogoFile(nom), undefined, nom)
    }
  })

  it('sert le logo public, gardé un an, sans rien exécuter', () => {
    const headers = emailLogoHeaders('image/svg+xml', 1234)
    assert.equal(headers['Content-Type'], 'image/svg+xml')
    assert.equal(headers['Content-Length'], '1234')
    assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable')
    assert.equal(headers['X-Content-Type-Options'], 'nosniff')
    assert.match(headers['Content-Security-Policy'], /default-src 'none'.*sandbox/)
  })
})

describe('taille du logo dans l’en-tête', () => {
  it('tient dans 220 × 56 pixels, proportions gardées', () => {
    assert.deepEqual(logoDisplaySize(600, 191), { width: 176, height: 56 })
    assert.deepEqual(logoDisplaySize(1000, 100), { width: 220, height: 22 })
    assert.deepEqual(logoDisplaySize(500, 500), { width: 56, height: 56 })
  })

  it('ne rend rien pour des dimensions illisibles', () => {
    assert.equal(logoDisplaySize(null, 100), null)
    assert.equal(logoDisplaySize(0, 100), null)
  })
})
