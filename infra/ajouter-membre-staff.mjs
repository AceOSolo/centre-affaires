/**
 * Inscrit une personne dans l'équipe du centre, c'est-à-dire lui ouvre le
 * back-office (ADR 008).
 *
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs alexis@exemple.fr --role super_admin --nom "Alexis Martin"
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs --lister
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs alexis@exemple.fr --lien
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs alexis@exemple.fr --retirer
 *
 * Rôles : `super_admin` (direction), `admin` (exploitant), `staff` (accueil).
 *
 * Amorçage : personne ne peut inscrire un membre depuis l'application tant
 * qu'aucun membre n'existe. Ce script est la porte d'entrée initiale, et il
 * s'exécute avec l'identité applicative — donc sous les gardes d'écriture par
 * centre, comme le ferait l'application.
 *
 * Une fois la première direction (`--role super_admin`) inscrite, l'équipe se
 * gère depuis l'écran Équipe du back-office (`/equipe`, ADR 019 et 054), qui
 * applique ses règles : la direction seule nomme ou retire un exploitant, on
 * ne se retire pas soi-même, le centre garde une direction. Le script reste
 * pour l'amorçage et le dépannage, et ne les applique pas.
 *
 * Personne ne crée plus son compte sur la page de connexion (ADR 068) : le
 * script affiche le lien d'invitation de la personne inscrite, valable sept
 * jours, à lui transmettre. Elle y choisit son mot de passe, puis se connecte
 * sur /auth/equipe ; le rattachement se fait à la première connexion.
 * `--lien` en donne un nouveau à un membre déjà inscrit (lien expiré).
 */
import { assurerCentre, dansLeCentre, ouvrirBase, uuidv7 } from './connexion.mjs'
import { afficherLien, preparerLienInvitation } from './lien-invitation.mjs'

const ROLES = ['super_admin', 'admin', 'staff']

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const has = (name) => args.includes(`--${name}`)

const email = args.find((arg) => !arg.startsWith('--') && arg.includes('@'))?.trim().toLowerCase()
const role = flag('role') ?? 'staff'
const fullName = flag('nom') ?? null

const { client } = ouvrirBase()

try {
  if (has('lister')) {
    const rows = await dansLeCentre(client, async (cnx) => {
      const [lignes] = await cnx.query(
        `select email, role, full_name, auth_user_id is not null as connecte, created_at
           from staff_members
          where deleted_at is null
          order by created_at`,
      )
      return lignes
    })
    if (rows.length === 0) {
      console.log("Aucun membre : le back-office n'est accessible à personne.")
    } else {
      console.log(`${rows.length} membre(s) :`)
      for (const row of rows) {
        const etat = row.connecte ? 'compte rattaché' : 'jamais connecté'
        console.log(`  ${row.email.padEnd(32)} ${row.role.padEnd(11)} ${etat}`)
      }
    }
    process.exit(0)
  }

  if (!email) {
    console.error(
      'Indiquer une adresse électronique.\n' +
        '  node --env-file=.env.local infra/ajouter-membre-staff.mjs <adresse> [--role super_admin|admin|staff] [--nom "Prénom Nom"]\n' +
        '  node --env-file=.env.local infra/ajouter-membre-staff.mjs <adresse> --lien\n' +
        '  node --env-file=.env.local infra/ajouter-membre-staff.mjs --lister',
    )
    process.exit(1)
  }

  if (has('lien')) {
    // Nouveau lien d'invitation pour un membre déjà inscrit (ADR 068).
    const lien = await dansLeCentre(client, async (cnx) => {
      const [[membre]] = await cnx.query(
        'select full_name from staff_members where email = ? and deleted_at is null',
        [email],
      )
      return membre ? preparerLienInvitation(cnx, { email, nom: membre.full_name, espace: 'equipe' }) : null
    })
    if (!lien) {
      console.log(`${email} ne fait pas partie de l'équipe : l'inscrire d'abord.`)
      process.exit(1)
    }
    afficherLien(email, lien, { espace: 'equipe' })
    process.exit(0)
  }

  if (has('retirer')) {
    // Retrait logique : l'accès cesse, la trace du passage reste (décision 6).
    const removed = await dansLeCentre(client, async (cnx) => {
      const [header] = await cnx.query(
        `update staff_members
            set deleted_at = CURRENT_TIMESTAMP(3)
          where email = ? and deleted_at is null`,
        [email],
      )
      return header.affectedRows
    })
    console.log(
      removed > 0
        ? `${email} n'a plus accès au back-office.`
        : `${email} ne fait pas partie de l'équipe.`,
    )
    process.exit(0)
  }

  if (!ROLES.includes(role)) {
    console.error(`Rôle inconnu : ${role}. Valeurs acceptées : ${ROLES.join(', ')}.`)
    process.exit(1)
  }

  const lien = await dansLeCentre(client, async (cnx) => {
    // Base vide : la ligne du centre est posée au premier ajout.
    await assurerCentre(cnx)
    // Lecture puis écriture : l'unicité de l'adresse ne vaut que pour les
    // membres vivants, un doublon est refusé ici plutôt que par un index.
    const [[existant]] = await cnx.query(
      'select id from staff_members where email = ? and deleted_at is null',
      [email],
    )
    if (existant) return false
    await cnx.query('insert into staff_members (id, email, role, full_name) values (?, ?, ?, ?)', [
      uuidv7(),
      email,
      role,
      fullName,
    ])
    // Le lien d'invitation, dans la même transaction (ADR 068).
    return preparerLienInvitation(cnx, { email, nom: fullName, espace: 'equipe' })
  })

  if (!lien) {
    console.log(`${email} fait déjà partie de l'équipe. Nouveau lien d'invitation : --lien.`)
    process.exit(0)
  }

  console.log(`${email} inscrit comme « ${role} ».`)
  afficherLien(email, lien, { espace: 'equipe' })
  console.log(
    'Prochaine étape : transmettre ce lien. La personne y choisit son mot de passe, puis se connecte ' +
      'sur /auth/equipe ; le rattachement se fait tout seul à la première connexion.',
  )
} finally {
  await client.end()
}
