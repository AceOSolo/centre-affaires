import { cache } from 'react'

import type { AuthenticatedUser } from '../../../lib/auth/membre.ts'
import { todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import type { ClientAccount } from '../../../modules/clients/comptes.ts'
import { clientSections } from '../../../modules/clients/espace-rubriques.ts'
import { listContractsForAccounts } from '../../../modules/contrats/compte-queries.ts'
import { mailFolderCounts } from '../../../modules/courrier/classement.ts'
import { searchMailForAccounts } from '../../../modules/courrier/demandes-queries.ts'
import { countToSign, listInspectionsForAccounts } from '../../../modules/etats-des-lieux/queries.ts'
import { listInvoicesForAccounts } from '../../../modules/facturation/compte-queries.ts'
import { listPortalOffers } from '../../../modules/facturation/offres-portail.ts'
import { splitClientBookings } from '../../../modules/reservations/compte-regles.ts'
import { listBookingsForAccounts } from '../../../modules/reservations/compte-queries.ts'

/** Plis montrés sur l'accueil : les derniers arrivés, le reste est dans la boîte. */
const LATEST_MAIL = 3

/**
 * Ce que l'espace sait d'une entreprise, lu une fois par requête : la coque
 * s'en sert pour ses onglets, l'accueil pour ses cartes. `cache` évite de
 * relire la même chose deux fois dans un même rendu.
 *
 * Reçoit le compte vérifié par l'appelant : chaque page et la coque appellent
 * `requireClientAccount()` elles-mêmes (`gardes-espace-client.test.ts`). Le
 * même objet revient de cet appel dans toute la requête, d'où un seul
 * chargement. Chaque lecture passe par les requêtes de son domaine, qui
 * portent déjà la portée client (`inClientSpace`, ADR 019).
 *
 * Aucun montant de facture : Dolibarr facture (ADR 046). Les factures du site
 * ne servent plus qu'à montrer, ou non, l'onglet de la page « Factures »,
 * restée en place et vide jusqu'à la seconde tranche.
 */
export const loadClientSpace = cache(async ({ user, accounts }: { user: AuthenticatedUser; accounts: ClientAccount[] }) => {
  const tenant = await currentTenant()
  const today = todayIsoDate(tenant.timezone)
  const now = new Date()

  const [bookings, invoices, contracts, inspections, mail, latestMail, offers] = await Promise.all([
    listBookingsForAccounts(accounts),
    listInvoicesForAccounts(accounts),
    listContractsForAccounts(accounts, today),
    listInspectionsForAccounts(accounts),
    mailFolderCounts(accounts),
    searchMailForAccounts(accounts, {}, { number: 1, size: LATEST_MAIL }, tenant.timezone),
    listPortalOffers(accounts, today),
  ])

  const activeContracts = contracts.filter((contract) => contract.status === 'active')
  const domiciliated = mail.total > 0 || activeContracts.some((contract) => contract.contractType === 'domiciliation')

  return {
    user,
    accounts,
    tenant,
    today,
    upcoming: splitClientBookings(bookings, now).upcoming,
    activeContracts,
    toSign: countToSign(inspections),
    domiciliated,
    mail,
    latestMail: latestMail.rows,
    offerCount: offers.length,
    sections: clientSections({
      domiciliated,
      invoices: invoices.length,
      contracts: contracts.length,
      inspections: inspections.length,
    }),
  }
})
