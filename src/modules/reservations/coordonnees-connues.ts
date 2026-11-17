import { withTenant } from '../../db/index.ts'
import { sessionUser } from '../../lib/auth/session.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { resolveClientAccounts } from '../clients/comptes.ts'
import { loadMemberProfile } from '../clients/mon-compte-queries.ts'
import { nameOf } from '../clients/prenom-nom.ts'

/** Coordonnées qui pré-remplissent une demande de la page publique (ADR 084). */
export type KnownContact = { firstName: string; lastName: string; email: string; phone: string; company: string }

/**
 * Coordonnées de la personne connectée à son espace client, pour pré-remplir
 * les demandes de la page publique : prénom, nom et téléphone de « Mon
 * compte », adresse du compte, et l'entreprise quand elle n'en représente
 * qu'une. Tout reste modifiable dans le formulaire.
 *
 * Lecture seule : contrairement à `clientAccess`, la simple visite de la page
 * d'accueil ne rattache ni ne crée aucune fiche (`emailVerified: false` ne
 * fait que lire les entreprises déjà rattachées au compte). Un visiteur
 * anonyme, ou un compte sans entreprise (l'équipe), ne reçoit rien.
 */
export async function loadKnownContact(): Promise<KnownContact | undefined> {
  const session = await sessionUser()
  if (!session) return undefined
  const { user } = session
  const accounts = await withTenant(currentTenantId(), (tx) => resolveClientAccounts(tx, user, { emailVerified: false }))
  if (accounts.length === 0) return undefined
  const profile = await loadMemberProfile(accounts)
  return {
    ...nameOf(profile, user.name),
    email: user.email,
    phone: profile.phone ?? '',
    company: accounts.length === 1 ? accounts[0].clientName : '',
  }
}
