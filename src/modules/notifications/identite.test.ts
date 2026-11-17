import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { EmailLogo } from '../../db/tenants.ts'
import {
  automaticSignatureLines,
  brandingOf,
  logoOf,
  normalizeSignature,
  normalizeWebsite,
  parseEmailIdentity,
  signatureLinesOf,
  type BrandingIdentity,
} from './identite.ts'

/**
 * Identité du centre dans ses courriels (ADR 080) : saisie de Configuration,
 * signature automatique ou saisie, logo des courriels ou du site.
 */
const handfield: BrandingIdentity = {
  name: 'Handfield',
  addressLine1: '6 rue de Copenhague',
  addressLine2: 'Pavillon jaune n° 7',
  postalCode: '38070',
  city: 'Saint-Quentin-Fallavier',
  phone: '04 28 35 09 31',
  email: 'accueil@centre.exemple',
  websiteUrl: 'https://www.handfield.fr',
  logoPath: '/handfield-logo.png',
  emailLogo: null,
  emailSignature: null,
}

const logo: EmailLogo = {
  id: '019a8f00-0000-7000-8000-00000000a001',
  key: 'centre/x/logo-courriels/019a8f00-0000-7000-8000-00000000a001.png',
  contentType: 'image/png',
  byteSize: 1000,
  width: 1000,
  height: 250,
}

describe('saisie du nom et de la signature', () => {
  it('enregistre nom, téléphone, site et lignes, nettoyés', () => {
    const result = parseEmailIdentity({
      name: '  Centre   Horizon ',
      phone: '04 28  35 09 31',
      websiteUrl: 'www.centre.exemple',
      emailSignature: '\r\n  Accueil du lundi au vendredi  \r\n\r\n8 h – 18 h\r\n',
    })
    assert.deepEqual(result, {
      ok: true,
      update: {
        name: 'Centre Horizon',
        phone: '04 28 35 09 31',
        websiteUrl: 'https://www.centre.exemple',
        emailSignature: 'Accueil du lundi au vendredi\n8 h – 18 h',
      },
    })
  })

  it('enregistre nuls les champs facultatifs vides : signature automatique', () => {
    const result = parseEmailIdentity({ name: 'Horizon', phone: '', websiteUrl: ' ', emailSignature: '\n \n' })
    assert.deepEqual(result, { ok: true, update: { name: 'Horizon', phone: null, websiteUrl: null, emailSignature: null } })
  })

  it('exige le nom du centre', () => {
    const result = parseEmailIdentity({ name: '  ' })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.fieldErrors.name)
  })

  it('refuse un téléphone ou un site illisibles', () => {
    const result = parseEmailIdentity({ name: 'Horizon', phone: 'appeler Paul', websiteUrl: 'ftp://centre.exemple' })
    assert.ok(!result.ok && result.fieldErrors.phone && result.fieldErrors.websiteUrl)
    assert.ok(!parseEmailIdentity({ name: 'Horizon', phone: '1234' }).ok)
  })

  it('lit une adresse de site avec ou sans https', () => {
    assert.equal(normalizeWebsite('https://www.handfield.fr/'), 'https://www.handfield.fr')
    assert.equal(normalizeWebsite('handfield.fr/contact'), 'https://handfield.fr/contact')
    assert.equal(normalizeWebsite(''), null)
    assert.equal(normalizeWebsite('localhost'), undefined)
    assert.equal(normalizeWebsite('javascript:alert(1)'), undefined)
  })

  it('borne la signature : six lignes, cent caractères, pas de séparateur', () => {
    assert.ok('error' in normalizeSignature('1\n2\n3\n4\n5\n6\n7'))
    assert.ok('error' in normalizeSignature('a'.repeat(101)))
    assert.ok('error' in normalizeSignature('Accueil\n—'))
    assert.deepEqual(normalizeSignature('Ligne'), { value: 'Ligne' })
  })
})

describe('signature', () => {
  it('reprend l’adresse, le téléphone, l’adresse électronique et le site du centre', () => {
    assert.deepEqual(automaticSignatureLines(handfield), [
      '6 rue de Copenhague, Pavillon jaune n° 7',
      '38070 Saint-Quentin-Fallavier',
      '04 28 35 09 31 · accueil@centre.exemple',
      'https://www.handfield.fr',
    ])
  })

  it('ne laisse pas de ligne vide pour une donnée absente', () => {
    assert.deepEqual(
      automaticSignatureLines({ ...handfield, addressLine1: null, addressLine2: ' ', phone: null, websiteUrl: '' }),
      ['38070 Saint-Quentin-Fallavier', 'accueil@centre.exemple'],
    )
  })

  it('prend les lignes saisies à la place', () => {
    assert.deepEqual(signatureLinesOf({ ...handfield, emailSignature: 'Accueil : 04 00 00 00 00\nwww.centre.exemple' }), [
      'Accueil : 04 00 00 00 00',
      'www.centre.exemple',
    ])
  })
})

describe('logo et habillage', () => {
  const context = {
    publicUrl: (path: string) => `https://centre.exemple${path}`,
    linkOrigins: ['https://centre.exemple'],
    siteLogoSize: { width: 600, height: 191 },
  }

  it('prend le logo déposé pour les courriels, sinon celui du site', () => {
    assert.deepEqual(logoOf({ logoPath: '/handfield-logo.png', emailLogo: logo }).path, `/medias/centre/logo/${logo.id}.png`)
    assert.deepEqual(logoOf(handfield), { source: 'site', path: '/handfield-logo.png', emailLogo: null })
  })

  it('n’appelle jamais un logo hébergé ailleurs', () => {
    for (const logoPath of ['https://cdn.exemple/logo.png', '//cdn.exemple/logo.png', null]) {
      assert.equal(logoOf({ logoPath, emailLogo: null }).source, 'aucun', String(logoPath))
    }
  })

  it('compose l’habillage : logo à l’adresse publique et à sa taille, signature, origines', () => {
    assert.deepEqual(brandingOf(handfield, context), {
      centreName: 'Handfield',
      logo: { url: 'https://centre.exemple/handfield-logo.png', width: 176, height: 56 },
      signatureLines: automaticSignatureLines(handfield),
      linkOrigins: ['https://centre.exemple'],
    })
    assert.deepEqual(brandingOf({ ...handfield, emailLogo: logo }, context).logo, {
      url: `https://centre.exemple/medias/centre/logo/${logo.id}.png`,
      width: 220,
      height: 55,
    })
  })

  it('part sans logo quand le site n’a pas d’adresse publique en https', () => {
    assert.equal(brandingOf(handfield, { ...context, publicUrl: () => null }).logo, null)
  })

  it('garde le logo sans dimensions quand elles sont illisibles', () => {
    assert.deepEqual(brandingOf(handfield, { ...context, siteLogoSize: null }).logo, {
      url: 'https://centre.exemple/handfield-logo.png',
      width: null,
      height: null,
    })
  })
})
