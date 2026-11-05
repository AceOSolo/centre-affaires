/**
 * Lien d'invitation préparé par un script d'exploitation (ADR 068) : la
 * première direction en production, les comptes de démonstration en local.
 *
 * Depuis la fermeture de l'inscription libre, personne ne crée son compte
 * sur la page de connexion. Le script fait ce que fait l'application
 * (`src/lib/auth/invitation.ts`) : un compte sans mot de passe, créé au
 * besoin, et un jeton `reset-password:<jeton>` valable sept jours dans
 * `auth_verifications` — celui que Better Auth vérifie quand le lien est
 * ouvert. Choisir son mot de passe confirme l'adresse.
 *
 * Le lien est affiché, pas envoyé : la personne qui lance le script le
 * transmet. Il vaut une fois.
 */
import { randomBytes, randomUUID } from 'node:crypto'

import {
  INVITATION_CALLBACK,
  INVITATION_JOURS,
  STAFF_INVITATION_CALLBACK,
} from '../src/lib/auth/messages.ts'

/**
 * Rend `{ url, expiresAt, created }`, ou `{ motDePasse: true }` quand le
 * compte a déjà un mot de passe : la personne se connecte avec lui.
 *
 * `cnx` : connexion `mysql2` d'une transaction (`dansLeCentre`).
 */
export async function preparerLienInvitation(cnx, { email, nom = null, espace = 'client' }) {
  const appUrl = process.env.APP_URL?.replace(/\/+$/, '')
  if (!appUrl) {
    throw new Error('APP_URL manquant : le lien d’invitation part de l’adresse publique de l’application (voir .env.example).')
  }
  const adresse = email.trim().toLowerCase()

  let created = false
  let [[compte]] = await cnx.query('select id from auth_users where email = ?', [adresse])
  if (compte) {
    const [[motDePasse]] = await cnx.query(
      "select 1 as oui from auth_accounts where user_id = ? and provider_id = 'credential' and password is not null limit 1",
      [compte.id],
    )
    if (motDePasse) return { motDePasse: true }
  } else {
    compte = { id: randomUUID() }
    await cnx.query(
      `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
       values (?, ?, ?, false, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [compte.id, nom ?? '', adresse],
    )
    created = true
  }

  // Même jeton que l'application : 18 octets, 24 caractères sûrs dans une adresse.
  const jeton = randomBytes(18).toString('base64url')
  await cnx.query(
    `insert into auth_verifications (id, identifier, value, expires_at, created_at, updated_at)
     values (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? DAY), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [randomUUID(), `reset-password:${jeton}`, compte.id, INVITATION_JOURS],
  )
  const destination = espace === 'equipe' ? STAFF_INVITATION_CALLBACK : INVITATION_CALLBACK
  return {
    url: `${appUrl}/api/auth/reset-password/${jeton}?callbackURL=${encodeURIComponent(destination)}`,
    expiresAt: new Date(Date.now() + INVITATION_JOURS * 86_400_000),
    created,
  }
}

/** Affiche le lien, ou ce que la personne doit faire si elle a déjà un mot de passe. */
export function afficherLien(email, lien, { espace = 'client' } = {}) {
  const connexion = espace === 'equipe' ? '/auth/equipe' : '/auth/connexion'
  if (lien.motDePasse) {
    console.log(`  ${email} a déjà un mot de passe : se connecter sur ${connexion}.`)
    return
  }
  console.log(`  Lien pour ${email}, valable une fois, ${INVITATION_JOURS} jours :`)
  console.log(`  ${lien.url}`)
}
