/**
 * Identité publique du centre.
 *
 *   npm run db:centre   # node --env-file=.env.local infra/configurer-centre.mjs
 *   CENTRE_EMAIL=accueil@… npm run db:centre   # avec l'adresse e-mail du centre
 *
 * Ce ne sont pas des données de démonstration : c'est la configuration du
 * centre, reprise du site public handfield.fr. Elle vit en base et non dans le
 * code, pour que le passage au multi-centres n'en demande pas la reprise
 * (décision 1).
 *
 * Le script est idempotent : le rejouer remet les valeurs ci-dessous, sauf
 * l'adresse e-mail du centre quand `CENTRE_EMAIL` n'est pas posée.
 */
import { withTenant } from '../src/db/index.ts'
import { isValidEmail, normaliseEmail } from '../src/modules/clients/contacts-regles.ts'
// Module TypeScript importé tel quel : Node 24 retire les types à la volée,
// comme pour `infra/chiffrer-documents.ts`.
import { seedExpectedServices } from '../src/modules/facturation/services-attendus.ts'
import { assurerCentre, dansLeCentre, DEFAULT_TENANT_ID, ouvrirBase, uuidv7 } from './connexion.mjs'

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
  // Adresse où partent les alertes à l'équipe (demandes de réservation et de
  // courrier, offres demandées, états des lieux signés, ADR 038), affichée
  // aussi dans l'espace client. Aucune n'est inventée : `CENTRE_EMAIL`, sinon
  // celle saisie à l'écran Configuration du centre, que le script ne touche pas.
  email: normaliseEmail(process.env.CENTRE_EMAIL ?? '') || null,
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
  // Les durées de conservation (courrier, demandes publiques, anonymisation,
  // journaux, photos) ne sont plus posées ici : elles se règlent à l'écran
  // Configuration du centre (R29, ADR 040). Rejouer ce script ne doit pas
  // défaire le choix du centre. Valeurs par défaut : celles des colonnes.
}

/**
 * Heures d'ouverture réelles : du lundi au vendredi, 8h00 – 18h00.
 *
 * Ce sont ces lignes, et non un texte dans la page, qui décident de ce
 * que le site public propose comme créneaux.
 */
const OUVERTURE = { opensAt: '08:00', closesAt: '18:00', weekdays: [1, 2, 3, 4, 5] }

/**
 * Prix HT, en centimes, des services que l'application retrouve par leur code
 * (`src/modules/facturation/services-attendus.ts`, ADR 024) : l'ouverture et
 * la numérisation d'un pli (R14), la numérisation seule d'un pli déjà ouvert
 * et la réexpédition, frais d'affranchissement en sus (R21, ADR 037), et la
 * page numérisée au-delà de celles comprises dans l'ouverture (ADR 044).
 *
 * Désignation, nature, unité et TVA (20 %, à valider avec l'expert-comptable)
 * viennent du module. Le prix, non : aucun n'est inventé (ADR 009). `null` :
 * le service n'est pas créé, et le script le signale. Un service déjà au
 * catalogue est laissé tel quel — son prix se gère ensuite à l'écran Services.
 */
const PRIX_DES_SERVICES = {
  'courrier.ouverture': null,
  'courrier.numerisation': null,
  'courrier.reexpedition': null,
  // Prix d'une page au-delà de celles comprises dans l'ouverture (ADR 044).
  'courrier.page': null,
}

// Même contrôle qu'à l'écran de configuration (`parseCentreContact`).
if (CENTRE.email && !isValidEmail(CENTRE.email)) {
  console.error(`CENTRE_EMAIL illisible : « ${CENTRE.email} ». Exemple : accueil@centre.fr`)
  process.exit(1)
}

const { client, db } = ouvrirBase()

try {
  const centre = await dansLeCentre(client, async (cnx) => {
    // Base vide : la ligne du centre est posée ici si aucun script ne l'a fait.
    await assurerCentre(cnx, { name: CENTRE.name, slug: CENTRE.slug })
    await cnx.query(
      `update tenants set
         name = ?, slug = ?, tagline = ?, legal_name = ?,
         address_line1 = ?, address_line2 = ?, postal_code = ?, city = ?, country = ?,
         phone = ?, email = coalesce(?, email), website_url = ?,
         logo_path = ?, logo_light_path = ?, hero_image_path = ?,
         social_links = ?, timezone = ?, currency = ?
       where id = ?`,
      [
        CENTRE.name, CENTRE.slug, CENTRE.tagline, CENTRE.legalName,
        CENTRE.addressLine1, CENTRE.addressLine2, CENTRE.postalCode, CENTRE.city, CENTRE.country,
        CENTRE.phone, CENTRE.email, CENTRE.websiteUrl,
        CENTRE.logoPath, CENTRE.logoLightPath, CENTRE.heroImagePath,
        JSON.stringify(CENTRE.socialLinks), CENTRE.timezone, CENTRE.currency,
        DEFAULT_TENANT_ID,
      ],
    )
    const [[row]] = await cnx.query(
      'select name, city, phone, email, logo_path from tenants where id = ?',
      [DEFAULT_TENANT_ID],
    )
    return row
  })

  const plages = await dansLeCentre(client, async (cnx) => {
    // Les horaires du centre, pas ceux d'une ressource précise : `resource_id`
    // nul vaut pour tout le centre.
    await cnx.query('delete from opening_hours where resource_id is null')
    for (const weekday of OUVERTURE.weekdays) {
      await cnx.query(
        `insert into opening_hours (id, resource_id, weekday, opens_at, closes_at)
         values (?, null, ?, ?, ?)`,
        [uuidv7(), weekday, OUVERTURE.opensAt, OUVERTURE.closesAt],
      )
    }
    return OUVERTURE.weekdays
  })

  const services = await withTenant(
    DEFAULT_TENANT_ID,
    (tx) => seedExpectedServices(tx, PRIX_DES_SERVICES),
    db,
  )

  console.log(`Centre configuré : ${centre.name}, ${centre.city} — ${centre.phone}`)
  if (centre.email) {
    console.log(`Adresse e-mail du centre : ${centre.email}`)
  } else {
    console.warn(
      'Adresse e-mail du centre non renseignée : les alertes à l’équipe ne partent pas. ' +
        'À saisir dans Réglages › Configuration du centre, ou rejouer avec CENTRE_EMAIL=…',
    )
  }
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
  await client.end()
}
