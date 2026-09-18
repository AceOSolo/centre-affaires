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
  ['salle', 'S-101', 'Salle Europe', 'Grande salle de réunion, vue sur cour.', 12, { superficieM2: 34, equipements: ['visio', 'tableau blanc', 'écran 55"'] }],
  ['salle', 'S-102', 'Salle Amérique', 'Salle de réunion intermédiaire.', 8, { superficieM2: 22, equipements: ['visio', 'tableau blanc'] }],
  ['salle', 'S-103', 'Salle Asie', 'Petite salle, entretiens et points rapides.', 4, { superficieM2: 11, equipements: ['écran 32"'] }],
  ['bureau', 'B-201', 'Bureau 201', 'Bureau fermé, deuxième étage.', 3, { superficieM2: 16, postes: 3 }],
  ['bureau', 'B-202', 'Bureau 202', 'Bureau fermé, deuxième étage.', 2, { superficieM2: 12, postes: 2 }],
  ['vehicule', 'VH-1', 'Utilitaire Kangoo', 'Réservable à la demi-journée.', 3, { immatriculation: 'AB-123-CD', kilometrage: 48250, places: 3 }],
  ['casier', 'C-12', 'Casier 12', null, null, { taille: 'M' }],
  ['boite_aux_lettres', 'BAL-07', 'Boîte aux lettres 07', 'Domiciliation.', null, {}],
]

/** Réservations posées en heure murale de Paris sur les jours autour d'aujourd'hui. */
const bookings = [
  [0, 'S-101', '09:00', '10:30', 'Comité de direction', 'Café et viennoiseries commandés.'],
  [0, 'S-101', '14:00', '16:00', 'Formation sécurité', null],
  [0, 'S-102', '10:00', '11:00', 'Entretien candidat — poste comptable', null],
  [0, 'S-102', '11:00', '12:00', 'Point hebdomadaire Dupont SARL', null],
  [0, 'S-103', '08:30', '09:00', 'Appel client Martin & Fils', null],
  [0, 'B-201', '09:00', '18:00', 'Bureau à la journée — Lefèvre Conseil', null],
  [0, 'VH-1', '13:30', '17:30', 'Livraison salon professionnel', 'Retour avant 18h.'],
  [1, 'S-101', '09:30', '11:00', 'Présentation trimestrielle', null],
  [1, 'S-103', '15:00', '16:00', 'Visite de locaux', null],
  [-1, 'S-102', '09:00', '10:00', 'Réunion reportée', null],
]

/** Jour du centre, décalé de `days` jours. */
const isoDate = (days) => addDaysToIsoDate(todayIsoDate(TIME_ZONE), days)

if (process.argv.includes('--vider')) {
  // Suppression physique assumée : ces lignes sont fictives et n'ont aucune
  // valeur légale, contrairement aux données que la décision 6 protège.
  await inTenant(async (tx) => {
    await tx`delete from bookings`
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
    for (const [type, code, name, description, capacity, attributes] of resources) {
      const [row] = await tx`
        insert into resources (resource_type, code, name, description, capacity, attributes)
        values (${type}, ${code}, ${name}, ${description}, ${capacity}, ${tx.json(attributes)})
        returning id`
      codeToId.set(code, row.id)
    }
  })

  await inTenant(async (tx) => {
    for (const [dayOffset, code, start, end, title, notes] of bookings) {
      const day = isoDate(dayOffset)
      await tx`
        insert into bookings (resource_id, starts_at, ends_at, title, notes)
        values (
          ${codeToId.get(code)},
          ${wallClockToUtc(`${day}T${start}`, TIME_ZONE)},
          ${wallClockToUtc(`${day}T${end}`, TIME_ZONE)},
          ${title},
          ${notes}
        )`
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
