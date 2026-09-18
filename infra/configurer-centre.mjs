/**
 * Identité publique du centre.
 *
 *   node --env-file=.env.local infra/configurer-centre.mjs
 *
 * Ce ne sont pas des données de démonstration : c'est la configuration du
 * centre, reprise du site public handfield.fr. Elle vit en base et non dans le
 * code, pour que le passage au multi-centres n'en demande pas la reprise
 * (décision 1).
 *
 * Le script est idempotent : le rejouer remet les valeurs ci-dessous.
 */
import postgres from 'postgres'

const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'

/**
 * Le logo est servi depuis `public/`, jamais appelé chez l'hébergeur du site
 * vitrine : une image distante livrerait l'adresse IP de chaque visiteur à un
 * tiers (ADR 004).
 */
const CENTRE = {
  name: 'Handfield',
  slug: 'handfield',
  tagline: 'Cultivateur de relations',
  legalName: 'SECUTOP',
  addressLine1: '6 rue de Copenhague',
  addressLine2: 'Pavillon jaune n° 7',
  postalCode: '38070',
  city: 'Saint-Quentin-Fallavier',
  country: 'FR',
  phone: '04 28 35 09 31',
  email: null,
  websiteUrl: 'https://www.handfield.fr',
  logoPath: '/handfield-logo.png',
  heroImagePath: '/photos/batiment.jpg',
  timezone: 'Europe/Paris',
  currency: 'EUR',
}

/**
 * Heures d'ouverture réelles : du lundi au vendredi, 8h00 – 18h00.
 *
 * Elles remplacent celles posées par défaut à la migration 0011, qui ouvraient
 * à 9h00. Ce sont ces lignes, et non un texte dans la page, qui décident de ce
 * que le site public propose comme créneaux.
 */
const OUVERTURE = { opensAt: '08:00', closesAt: '18:00', weekdays: [1, 2, 3, 4, 5] }

const url = process.env.APP_DATABASE_URL
if (!url) {
  console.error('APP_DATABASE_URL manquant (voir .env.example).')
  process.exit(1)
}

const sql = postgres(url, { prepare: false })

try {
  const [centre] = await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    return tx`
      update tenants set
        name           = ${CENTRE.name},
        slug           = ${CENTRE.slug},
        tagline        = ${CENTRE.tagline},
        legal_name     = ${CENTRE.legalName},
        address_line1  = ${CENTRE.addressLine1},
        address_line2  = ${CENTRE.addressLine2},
        postal_code    = ${CENTRE.postalCode},
        city           = ${CENTRE.city},
        country        = ${CENTRE.country},
        phone          = ${CENTRE.phone},
        email          = ${CENTRE.email},
        website_url    = ${CENTRE.websiteUrl},
        logo_path      = ${CENTRE.logoPath},
        hero_image_path = ${CENTRE.heroImagePath},
        timezone       = ${CENTRE.timezone},
        currency       = ${CENTRE.currency}
      where id = ${DEFAULT_TENANT_ID}
      returning name, city, phone, logo_path`
  })

  if (!centre) {
    console.error(
      "Le centre unique est absent de la base. Appliquer les migrations d'abord : npx drizzle-kit migrate",
    )
    process.exit(1)
  }

  const plages = await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    // Les horaires du centre, pas ceux d'une ressource précise : `resource_id`
    // nul vaut pour tout le centre.
    await tx`delete from opening_hours where resource_id is null`
    return tx`
      insert into opening_hours (weekday, opens_at, closes_at)
      select unnest(${OUVERTURE.weekdays}::int[]), ${OUVERTURE.opensAt}::time, ${OUVERTURE.closesAt}::time
      returning weekday`
  })

  console.log(`Centre configuré : ${centre.name}, ${centre.city} — ${centre.phone}`)
  console.log(
    `Ouverture : ${plages.length} jours, ${OUVERTURE.opensAt} – ${OUVERTURE.closesAt}`,
  )
  console.log(`Logo servi depuis ${centre.logo_path}`)
} finally {
  await sql.end()
}
