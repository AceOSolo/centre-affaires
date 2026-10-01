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

// Module TypeScript importé tel quel : Node 24 retire les types à la volée,
// comme pour `infra/chiffrer-documents.ts`.
import { seedExpectedServices } from '../src/modules/facturation/services-attendus.ts'

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
  logoLightPath: '/handfield-logo-blanc.png',
  heroImagePath: '/photos/batiment.jpg',
  socialLinks: [
    { label: 'LinkedIn', url: 'https://www.linkedin.com/company/handfield/' },
    { label: 'Facebook', url: 'https://www.facebook.com/Handfield-105320951354193' },
  ],
  timezone: 'Europe/Paris',
  currency: 'EUR',
  // Conservation du courrier numérisé et du journal d'accès, en mois (RGPD,
  // ADR 015). Validées par le centre le 2026-09-30 ; à reporter au contrat
  // de domiciliation.
  mailScanRetentionMonths: 12,
  mailAccessLogRetentionMonths: 12,
  // Coordonnées des demandeurs de la page publique (ADR 005, ADR 020), en mois
  // depuis la fin du créneau demandé. Douze mois par défaut, à faire valider
  // par le centre (B4).
  publicRequestRetentionMonths: 12,
}

/**
 * Heures d'ouverture réelles : du lundi au vendredi, 8h00 – 18h00.
 *
 * Elles remplacent celles posées par défaut à la migration 0011, qui ouvraient
 * à 9h00. Ce sont ces lignes, et non un texte dans la page, qui décident de ce
 * que le site public propose comme créneaux.
 */
const OUVERTURE = { opensAt: '08:00', closesAt: '18:00', weekdays: [1, 2, 3, 4, 5] }

/**
 * Prix HT, en centimes, des services que l'application retrouve par leur code
 * (`src/modules/facturation/services-attendus.ts`, ADR 024) : aujourd'hui
 * l'ouverture et la numérisation d'un pli, valorisée sur la facture (R14).
 *
 * Désignation, nature, unité et TVA (20 %, à valider avec l'expert-comptable)
 * viennent du module. Le prix, non : aucun n'est inventé (ADR 009). `null` :
 * le service n'est pas créé, et le script le signale. Un service déjà au
 * catalogue est laissé tel quel — son prix se gère ensuite à l'écran Services.
 */
const PRIX_DES_SERVICES = {
  'courrier.ouverture': null,
}

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
        logo_light_path = ${CENTRE.logoLightPath},
        hero_image_path = ${CENTRE.heroImagePath},
        social_links    = ${sql.json(CENTRE.socialLinks)},
        timezone       = ${CENTRE.timezone},
        currency       = ${CENTRE.currency},
        mail_scan_retention_months       = ${CENTRE.mailScanRetentionMonths},
        mail_access_log_retention_months = ${CENTRE.mailAccessLogRetentionMonths},
        public_request_retention_months  = ${CENTRE.publicRequestRetentionMonths}
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

  const services = await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    return seedExpectedServices(tx, PRIX_DES_SERVICES)
  })

  console.log(`Centre configuré : ${centre.name}, ${centre.city} — ${centre.phone}`)
  for (const code of services.created) console.log(`Service créé : ${code}`)
  for (const code of services.existing) {
    console.log(`Service ${code} déjà au catalogue : laissé tel quel.`)
  }
  for (const code of services.withoutPrice) {
    console.warn(
      `Service ${code} non créé : prix à fixer dans PRIX_DES_SERVICES, ou à l’écran Services. ` +
        "D'ici là, ces actes ne sont pas valorisés sur les factures.",
    )
  }
  console.log(
    `Ouverture : ${plages.length} jours, ${OUVERTURE.opensAt} – ${OUVERTURE.closesAt}`,
  )
  console.log(`Logo servi depuis ${centre.logo_path}`)
} finally {
  await sql.end()
}
