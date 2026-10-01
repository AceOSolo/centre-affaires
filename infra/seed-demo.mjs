/**
 * Jeu de démonstration pour le développement local.
 *
 * Données entièrement fictives : aucune donnée réelle ne doit atteindre un
 * environnement de développement (contrainte RGPD de CLAUDE.md). Ce script n'a
 * rien à faire en production, et refuse de s'exécuter sur une base qui contient
 * déjà des réservations.
 *
 *   node --env-file=.env.local infra/seed-demo.mjs
 *
 * Il se connecte avec le rôle applicatif, donc sous les politiques d'isolation
 * par centre : ce qu'il écrit est exactement ce que l'application pourrait
 * écrire.
 */
import postgres from 'postgres'

// Les instants sont calculés par la fonction de l'application, pas par une
// copie : le jeu de démonstration doit poser exactement les mêmes heures que
// le formulaire de réservation.
import { addDaysToIsoDate, todayIsoDate, wallClockToUtc } from '../src/lib/dates.ts'

const TIME_ZONE = 'Europe/Paris'

const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'

const url = process.env.APP_DATABASE_URL
if (!url) {
  console.error(
    'APP_DATABASE_URL manquant. Lancer `node infra/provision-role-applicatif.mjs` au préalable.',
  )
  process.exit(1)
}

const sql = postgres(url, { prepare: false })

/** Ouvre une transaction dans le contexte du centre, comme `withTenant()`. */
const inTenant = (run) =>
  sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    return run(tx)
  })

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

/** Jour du centre, décalé de `days` jours. */
const isoDate = (days) => addDaysToIsoDate(todayIsoDate(TIME_ZONE), days)

if (process.argv.includes('--vider')) {
  // Suppression physique assumée : ces lignes sont fictives et n'ont aucune
  // valeur légale, contrairement aux données que la décision 6 protège.
  //
  // Encore faut-il qu'elles le soient. `infra/catalogue.mjs` écrit le parc réel
  // du centre dans les mêmes tables : effacer sans regarder détruirait une
  // configuration, pas un jeu d'essai — et `--vider` s'exécute avant le
  // garde-fou de la suite, donc plus rien ne l'arrêterait. Le script refuse dès
  // qu'il trouve une ressource qui ne vient pas d'ici.
  const codesDemo = resources.map(([, code]) => code)
  const intruses = await inTenant(
    (tx) => tx`select code from resources where not (code = any(${codesDemo})) order by code`,
  )
  if (intruses.length > 0) {
    const apercu = intruses.slice(0, 5).map(({ code }) => code)
    console.error(
      `La base contient ${intruses.length} ressource(s) étrangères au jeu de démonstration ` +
        `(${apercu.join(', ')}${intruses.length > apercu.length ? ', …' : ''}) : ` +
        "rien n'a été effacé. C'est probablement le catalogue réel du centre " +
        '(infra/catalogue.mjs) : le vider se décide à la main, pas par un script de démo.',
    )
    process.exit(1)
  }

  await inTenant(async (tx) => {
    await tx`delete from bookings`
    await tx`delete from rate_plan_items`
    await tx`delete from rate_plans`
    await tx`delete from resources`
  })
  console.log('Jeu de démonstration effacé.')
}

try {
  // Le garde-fou porte sur les deux tables : les ressources sont écrites avant
  // les réservations, une base qui n'a que des ressources est un jeu à moitié
  // posé, pas une base vierge.
  const [existing] = await inTenant(
    (tx) => tx`
      select (select count(*) from resources)::int as resources,
             (select count(*) from bookings)::int as bookings`,
  )
  if (existing.resources > 0 || existing.bookings > 0) {
    console.error(
      `La base contient déjà ${existing.resources} ressource(s) et ${existing.bookings} ` +
        "réservation(s) : rien n'a été écrit. " +
        'Pour repartir de zéro : node --env-file=.env.local infra/seed-demo.mjs --vider',
    )
    process.exit(1)
  }

  const codeToId = new Map()

  await inTenant(async (tx) => {
    for (const [type, code, name, description, capacity, attributes, photo] of resources) {
      const [row] = await tx`
        insert into resources (resource_type, code, name, description, capacity, attributes, photo_path)
        values (${type}, ${code}, ${name}, ${description}, ${capacity}, ${tx.json(attributes)}, ${photo})
        returning id`
      codeToId.set(code, row.id)
    }
  })

  await inTenant(async (tx) => {
    for (const [dayOffset, code, start, end, title, notes] of bookings) {
      const day = isoDate(dayOffset)
      await tx`
        insert into bookings (resource_id, channel, starts_at, ends_at, title, notes)
        values (
          ${codeToId.get(code)},
          'staff',
          ${wallClockToUtc(`${day}T${start}`, TIME_ZONE)},
          ${wallClockToUtc(`${day}T${end}`, TIME_ZONE)},
          ${title},
          ${notes}
        )`
    }
  })

  // Grille d'essai, montants inventés. Les tarifs réels du centre vivent dans
  // `infra/catalogue.mjs` (ADR 009) : les répéter ici en ferait une seconde
  // vérité à corriger à chaque révision de prix.
  await inTenant(async (tx) => {
    const [grille] = await tx`
      insert into rate_plans (name, currency, is_default)
      values ('Grille de démonstration', 'EUR', true)
      returning id`
    for (const [unit, amount] of [
      ['half_day', 7_500],
      ['day', 11_000],
    ]) {
      await tx`
        insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
        values (${grille.id}, 'salle', ${unit}, ${amount})`
    }
  })

  // Une annulée, pour que l'écran montre aussi ce cas : le créneau est libre,
  // la ligne reste (décision 6).
  await inTenant(
    (tx) => tx`
      update bookings
         set status = 'cancelled',
             cancelled_at = now(),
             cancellation_reason = 'Client absent'
       where title = 'Réunion reportée'`,
  )

  console.log(
    `${resources.length} ressources et ${bookings.length} réservations fictives insérées.`,
  )
} finally {
  await sql.end()
}
