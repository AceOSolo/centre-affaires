/**
 * Jeu de démonstration pour le développement local : la seule source de
 * données de départ d'une base vide.
 *
 * Données entièrement fictives : aucune donnée réelle ne doit atteindre un
 * environnement de développement (contrainte RGPD de CLAUDE.md). Ce script n'a
 * rien à faire en production, et refuse de s'exécuter sur une base qui contient
 * déjà des ressources ou des réservations.
 *
 *   npm run db:migrer      # structure et règles, base vide
 *   npm run db:seed        # node --env-file=.env.local infra/seed-demo.mjs
 *
 * Il se connecte avec l'identité applicative (`DB_USER`), donc sous les gardes
 * d'écriture par centre : ce qu'il écrit est ce que l'application pourrait
 * écrire.
 *
 * Il produit un centre exploitable : ressources, horaires, réservations,
 * entreprises clientes et leurs contacts, contrats, grille tarifaire, services,
 * et un exploitant de démonstration invité par son adresse `demo@exemple.test`.
 * Son compte n'existe pas encore : il se crée par inscription sur
 * /auth/connexion (avec `AUTH_SKIP_EMAIL_VERIFICATION=true` en développement,
 * la session s'ouvre directement) ; le rattachement se fait à la première
 * connexion.
 *
 * Pour repartir de zéro, recréer la base (`drop database` puis
 * `npm run db:migrer`) : les occupations de contrat ne se suppriment que par
 * leur contrat, et un effacement physique partiel laisserait un jeu bancal.
 */
// Les instants sont calculés par la fonction de l'application, pas par une
// copie : le jeu de démonstration doit poser exactement les mêmes heures que
// le formulaire de réservation.
import { addDaysToIsoDate, todayIsoDate, wallClockToUtc } from '../src/lib/dates.ts'
import { assurerCentre, dansLeCentre, ouvrirBase, uuidv7 } from './connexion.mjs'

const TIME_ZONE = 'Europe/Paris'

const COURRIEL_EXPLOITANT_DEMO = 'demo@exemple.test'

const resources = [
  ['salle', 'S-MB', 'Salle Mont Blanc', 'Espace modulable : formation, séminaire, réunion.', 14, { superficieM2: 30, equipements: ['écran tactile', 'paperboard', 'wifi'] }, '/photos/salle-mont-blanc.jpg'],
  ['salle', 'S-AE', 'Salle Albert Einstein', 'Espace flexible : réunion, formation, séminaire, activité sportive.', 16, { equipements: ['wifi', 'purificateur d’air'] }, '/photos/salle-albert-einstein.jpg'],
  ['bureau', 'B-01', 'Bureau 1', 'Bureau fermé, location au mois.', 3, { postes: 3 }, '/photos/accueil.jpg'],
  ['bureau', 'B-02', 'Bureau 2', 'Bureau fermé, location au mois.', 2, { postes: 2 }, '/photos/accueil.jpg'],
  ['boite_aux_lettres', 'DOM-01', 'Domiciliation 01', 'Adresse commerciale et réception du courrier.', null, {}, null],
  ['boite_aux_lettres', 'DOM-02', 'Domiciliation 02', 'Adresse commerciale et réception du courrier.', null, {}, null],
]

/** Réservations posées en heure murale de Paris sur les jours autour d'aujourd'hui. */
const bookings = [
  [0, 'S-MB', '09:00', '12:00', 'Formation habilitation électrique', 'Café et viennoiseries commandés.'],
  [0, 'S-MB', '14:00', '17:30', 'Séminaire de rentrée — Delta Industries', null],
  [0, 'S-AE', '10:00', '11:00', 'Entretien de recrutement', null],
  [0, 'S-AE', '11:00', '12:00', 'Point hebdomadaire Dupont SARL', null],
  [0, 'B-01', '08:00', '18:00', 'Bureau à la journée — Lefèvre Conseil', null],
  [1, 'S-MB', '09:30', '12:30', 'Présentation trimestrielle', null],
  [1, 'S-AE', '15:00', '16:00', 'Visite de locaux', null],
  [-1, 'S-AE', '09:00', '10:00', 'Réunion reportée', null],
]

/** Une annulée, pour que l'écran montre aussi ce cas : le créneau est libre, la ligne reste (décision 6). */
const RESERVATION_ANNULEE = 'Réunion reportée'

// Entreprises fictives ; adresses en `.test` (domaine réservé, jamais routé).
const clients = [
  { cle: 'delta', name: 'Delta Industries', legalForm: 'SAS', status: 'active', email: 'contact@delta-industries.exemple.test', phone: '04 76 00 00 01', addressLine1: '12 avenue de la Gare', postalCode: '38000', city: 'Grenoble' },
  { cle: 'dupont', name: 'Dupont SARL', legalForm: 'SARL', status: 'active', email: 'bonjour@dupont-sarl.exemple.test', phone: '04 74 00 00 02', addressLine1: '3 rue des Tisserands', postalCode: '38090', city: 'Villefontaine' },
  { cle: 'lefevre', name: 'Lefèvre Conseil', legalForm: 'EURL', status: 'active', email: 'contact@lefevre-conseil.exemple.test', phone: '04 74 00 00 03', addressLine1: '8 place du Marché', postalCode: '38070', city: 'Saint-Quentin-Fallavier' },
  { cle: 'moreau', name: 'Atelier Moreau', legalForm: 'SAS', status: 'prospect', email: 'atelier@moreau.exemple.test', phone: null, addressLine1: null, postalCode: null, city: 'Bourgoin-Jallieu' },
]

const contacts = [
  ['delta', 'Claire Fontaine', 'Gérante', 'claire.fontaine@delta-industries.exemple.test', '06 00 00 00 01', true, false],
  ['delta', 'Marc Aubert', 'Comptable', 'compta@delta-industries.exemple.test', null, false, true],
  ['dupont', 'Jean Dupont', 'Gérant', 'jean.dupont@dupont-sarl.exemple.test', '06 00 00 00 02', true, true],
  ['lefevre', 'Sophie Lefèvre', 'Consultante', 'sophie.lefevre@lefevre-conseil.exemple.test', '06 00 00 00 03', true, true],
]

// Accès à l'espace client de Delta Industries : même principe que l'exploitant,
// le compte se crée par inscription avec cette adresse.
const membres = [['delta', 'client.demo@exemple.test', 'Claire Fontaine']]

/** Premier jour du mois dernier : les contrats en cours ont déjà une facturation à préparer. */
const debutContrat = (() => {
  const [annee, mois] = addDaysToIsoDate(todayIsoDate(TIME_ZONE), -35).split('-')
  return `${annee}-${mois}-01`
})()

// Contrats : la référence est posée ici (hors série du centre) pour ne pas
// consommer la numérotation `CT-AAAA-NNNN` avec des contrats fictifs.
const contracts = [
  { cle: 'delta', ref: 'CT-DEMO-001', type: 'domiciliation', status: 'active', resource: 'DOM-01', amount: 3_000, notice: 90 },
  { cle: 'lefevre', ref: 'CT-DEMO-002', type: 'bureau', status: 'active', resource: 'B-02', amount: 22_000, notice: 90 },
  { cle: 'dupont', ref: 'CT-DEMO-003', type: 'domiciliation', status: 'draft', resource: null, amount: 3_000, notice: 90 },
]

// Montants inventés ; les services du courrier (ouverture, numérisation,
// réexpédition) sont ceux que le code retrouve par leur code (ADR 024).
const services = [
  { code: 'courrier.ouverture', name: 'Ouverture et numérisation d’un pli', nature: 'act', unit: 'unit', price: 350 },
  { code: 'courrier.numerisation', name: 'Numérisation d’un pli déjà ouvert', nature: 'act', unit: 'unit', price: 200 },
  { code: 'courrier.reexpedition', name: 'Réexpédition d’un pli', nature: 'act', unit: 'unit', price: 500 },
  { code: 'domiciliation.forfait', name: 'Forfait domiciliation', nature: 'package', unit: 'month', price: 3_000 },
]

/** Jour du centre, décalé de `days` jours. */
const isoDate = (days) => addDaysToIsoDate(todayIsoDate(TIME_ZONE), days)

const { client } = ouvrirBase()

try {
  const bilan = await dansLeCentre(client, async (cnx) => {
    await assurerCentre(cnx)

    // Le garde-fou porte sur les deux tables : les ressources sont écrites
    // avant les réservations, une base qui n'a que des ressources est un jeu à
    // moitié posé, pas une base vierge.
    const [[existing]] = await cnx.query(
      `select (select count(*) from resources) as resources,
              (select count(*) from bookings) as bookings`,
    )
    if (Number(existing.resources) > 0 || Number(existing.bookings) > 0) {
      console.error(
        `La base contient déjà ${existing.resources} ressource(s) et ${existing.bookings} ` +
          "réservation(s) : rien n'a été écrit. Pour repartir de zéro, recréer la base " +
          'puis relancer `npm run db:migrer` et `npm run db:seed`.',
      )
      process.exit(1)
    }

    const resourceId = new Map()
    for (const [type, code, name, description, capacity, attributes, photo] of resources) {
      const id = uuidv7()
      resourceId.set(code, id)
      await cnx.query(
        `insert into resources (id, resource_type, code, name, description, capacity, attributes, photo_path)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, code, name, description, capacity, JSON.stringify(attributes), photo],
      )
    }

    // Horaires du centre entier (`resource_id` nul) : du lundi au vendredi.
    for (const weekday of [1, 2, 3, 4, 5]) {
      await cnx.query(
        'insert into opening_hours (id, resource_id, weekday, opens_at, closes_at) values (?, null, ?, ?, ?)',
        [uuidv7(), weekday, '08:00', '18:00'],
      )
    }

    // Grille d'essai, montants inventés. Les tarifs réels du centre vivent dans
    // `infra/catalogue.mjs` (ADR 009) : les répéter ici en ferait une seconde
    // vérité à corriger à chaque révision de prix.
    const ratePlanId = uuidv7()
    await cnx.query(
      `insert into rate_plans (id, name, currency, is_default) values (?, 'Grille de démonstration', 'EUR', true)`,
      [ratePlanId],
    )
    for (const [type, unit, amount] of [
      ['salle', 'half_day', 7_500],
      ['salle', 'day', 11_000],
      ['bureau', 'half_day', 700],
      ['boite_aux_lettres', 'month', 3_000],
    ]) {
      await cnx.query(
        `insert into rate_plan_items (id, rate_plan_id, resource_type, unit, amount_cents)
         values (?, ?, ?, ?, ?)`,
        [uuidv7(), ratePlanId, type, unit, amount],
      )
    }

    for (const service of services) {
      await cnx.query(
        `insert into services (id, code, name, nature, unit, unit_price_cents, vat_rate_bp)
         values (?, ?, ?, ?, ?, ?, 2000)`,
        [uuidv7(), service.code, service.name, service.nature, service.unit, service.price],
      )
    }

    const clientId = new Map()
    for (const c of clients) {
      const id = uuidv7()
      clientId.set(c.cle, id)
      await cnx.query(
        `insert into clients (id, name, legal_form, status, email, phone, address_line1, postal_code, city)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, c.name, c.legalForm, c.status, c.email, c.phone, c.addressLine1, c.postalCode, c.city],
      )
    }

    for (const [cle, fullName, jobTitle, email, phone, isPrimary, isBilling] of contacts) {
      await cnx.query(
        `insert into client_contacts (id, client_id, full_name, job_title, email, phone, is_primary, is_billing)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv7(), clientId.get(cle), fullName, jobTitle, email, phone, isPrimary, isBilling],
      )
    }

    for (const [cle, email, fullName] of membres) {
      await cnx.query(
        'insert into client_members (id, client_id, email, full_name) values (?, ?, ?, ?)',
        [uuidv7(), clientId.get(cle), email, fullName],
      )
    }

    // Un contrat en cours qui réserve une ressource en pose l'occupation
    // (ADR 018) : la base s'en charge, le script n'écrit pas de réservation.
    for (const c of contracts) {
      await cnx.query(
        `insert into contracts (id, client_id, reference, contract_type, status, starts_on,
                                amount_cents, notice_days, rate_plan_id, resource_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(), clientId.get(c.cle), c.ref, c.type, c.status, debutContrat,
          c.amount, c.notice, ratePlanId, c.resource ? resourceId.get(c.resource) : null,
        ],
      )
    }

    for (const [dayOffset, code, start, end, title, notes] of bookings) {
      const day = isoDate(dayOffset)
      const annulee = title === RESERVATION_ANNULEE
      await cnx.query(
        `insert into bookings (id, resource_id, channel, starts_at, ends_at, title, notes,
                               status, cancelled_at, cancellation_reason)
         values (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(), resourceId.get(code),
          wallClockToUtc(`${day}T${start}`, TIME_ZONE), wallClockToUtc(`${day}T${end}`, TIME_ZONE),
          title, notes,
          annulee ? 'cancelled' : 'confirmed',
          annulee ? new Date() : null,
          annulee ? 'Client absent' : null,
        ],
      )
    }

    // L'exploitant de démonstration : invité par son adresse, sans compte.
    await cnx.query(
      `insert into staff_members (id, email, role, full_name) values (?, ?, 'admin', 'Exploitant de démonstration')`,
      [uuidv7(), COURRIEL_EXPLOITANT_DEMO],
    )

    return {
      resources: resources.length,
      bookings: bookings.length,
      clients: clients.length,
      contracts: contracts.length,
    }
  })

  console.log(
    `${bilan.resources} ressources, ${bilan.bookings} réservations, ${bilan.clients} entreprises ` +
      `et ${bilan.contracts} contrats fictifs insérés.`,
  )
  console.log(
    `Exploitant de démonstration : ${COURRIEL_EXPLOITANT_DEMO}. Créer son compte sur /auth/connexion ` +
      "(« Créer votre accès » ; avec AUTH_SKIP_EMAIL_VERIFICATION=true, la session s'ouvre directement).",
  )
} finally {
  await client.end()
}
