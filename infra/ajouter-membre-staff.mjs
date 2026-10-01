/**
 * Inscrit une personne dans l'équipe du centre, c'est-à-dire lui ouvre le
 * back-office (ADR 008).
 *
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs alexis@exemple.fr --role admin --nom "Alexis Martin"
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs --lister
 *   node --env-file=.env.local infra/ajouter-membre-staff.mjs alexis@exemple.fr --retirer
 *
 * Amorçage : personne ne peut inscrire un membre depuis l'application tant
 * qu'aucun membre n'existe. Ce script est la porte d'entrée initiale, et il
 * s'exécute avec le rôle applicatif — donc sous les politiques d'isolation par
 * centre, comme le ferait l'application.
 *
 * Une fois le premier exploitant (`--role admin`) inscrit, l'équipe se gère
 * depuis l'écran Équipe du back-office (`/equipe`, ADR 019), qui applique ses
 * règles : ni se retirer soi-même, ni retirer ou rétrograder le dernier
 * exploitant. Le script reste pour l'amorçage et le dépannage, et ne les
 * applique pas.
 *
 * La personne inscrite n'a pas encore de compte : elle en crée un sur
 * /auth/connexion avec cette adresse, et le rattachement se fait à la première
 * connexion.
 */
import postgres from 'postgres'

const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'
const ROLES = ['admin', 'staff']

const url = process.env.APP_DATABASE_URL
if (!url) {
  console.error('APP_DATABASE_URL manquant (voir .env.example).')
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const has = (name) => args.includes(`--${name}`)

const email = args.find((arg) => !arg.startsWith('--') && arg.includes('@'))?.trim().toLowerCase()
const role = flag('role') ?? 'staff'
const fullName = flag('nom') ?? null

const sql = postgres(url, { prepare: false })

const inTenant = (run) =>
  sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    return run(tx)
  })

try {
  if (has('lister')) {
    const rows = await inTenant(
      (tx) => tx`
        select email, role, full_name, auth_user_id is not null as connecte, created_at
          from staff_members
         where deleted_at is null
         order by created_at`,
    )
    if (rows.length === 0) {
      console.log("Aucun membre : le back-office n'est accessible à personne.")
    } else {
      console.log(`${rows.length} membre(s) :`)
      for (const row of rows) {
        const etat = row.connecte ? 'compte rattaché' : 'jamais connecté'
        console.log(`  ${row.email.padEnd(32)} ${row.role.padEnd(6)} ${etat}`)
      }
    }
    process.exit(0)
  }

  if (!email) {
    console.error(
      'Indiquer une adresse électronique.\n' +
        '  node --env-file=.env.local infra/ajouter-membre-staff.mjs <adresse> [--role admin|staff] [--nom "Prénom Nom"]\n' +
        '  node --env-file=.env.local infra/ajouter-membre-staff.mjs --lister',
    )
    process.exit(1)
  }

  if (has('retirer')) {
    // Retrait logique : l'accès cesse, la trace du passage reste (décision 6).
    const removed = await inTenant(
      (tx) => tx`
        update staff_members
           set deleted_at = now()
         where email = ${email} and deleted_at is null
         returning email`,
    )
    console.log(
      removed.length > 0
        ? `${email} n'a plus accès au back-office.`
        : `${email} ne fait pas partie de l'équipe.`,
    )
    process.exit(0)
  }

  if (!ROLES.includes(role)) {
    console.error(`Rôle inconnu : ${role}. Valeurs acceptées : ${ROLES.join(', ')}.`)
    process.exit(1)
  }

  const [membre] = await inTenant(
    (tx) => tx`
      insert into staff_members (email, role, full_name)
      values (${email}, ${role}, ${fullName})
      on conflict do nothing
      returning email, role`,
  )

  if (!membre) {
    console.log(`${email} fait déjà partie de l'équipe.`)
    process.exit(0)
  }

  console.log(`${membre.email} inscrit comme « ${membre.role} ».`)
  console.log(
    "Prochaine étape : la personne crée son compte sur /auth/connexion avec cette adresse ; " +
      'le rattachement se fait tout seul à la première connexion.',
  )
} finally {
  await sql.end()
}
