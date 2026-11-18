'use server'

import { headers } from 'next/headers'

import { getAuth } from '../../lib/auth/server.ts'
import { accesPourLaPorte } from './deja-connecte-serveur.ts'
import { ouvreLaPorte, type PageDeConnexion } from './deja-connecte.ts'

/**
 * Appelée par le formulaire de connexion sitôt la session ouverte (ADR 083) :
 * le compte ouvre-t-il l'espace de la page par laquelle il est entré ? Sinon
 * la session est refermée ici même, et le formulaire dit d'utiliser l'autre
 * page de connexion.
 *
 * Une commodité de parcours, pas la protection : chaque page et chaque action
 * revérifient le compte (`requirePermission()`, `requireClientAccount()`).
 */
export async function verifierPorteAction(page: PageDeConnexion): Promise<boolean> {
  const acces = await accesPourLaPorte(page)
  if (!acces) return false
  if (ouvreLaPorte(page, acces)) return true
  await getAuth().api.signOut({ headers: await headers() })
  return false
}
