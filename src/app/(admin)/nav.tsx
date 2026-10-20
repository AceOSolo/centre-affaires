'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useId } from 'react'

import type { Permission } from '../../lib/auth/permissions.ts'
import type { ProductKey } from '../../modules/ressources/produits.ts'
import { activeEntry } from './nav-actif.ts'

type Entry = {
  href: string
  label: string
  permission: Permission
  /** Compteur de file d'attente affiché à côté du libellé. */
  counter?: 'pending' | 'mail'
  /** File d'un seul produit : le compteur `pending` est alors le sien. */
  product?: ProductKey
  /**
   * Adresse qui allume l'entrée quand elle diffère du lien : le planning du
   * camion s'ouvre sur la semaine et reste allumé sur la vue du jour.
   */
  match?: string
}

/** Demandes d'un produit, avec le compteur de sa file. */
const requests = (product: ProductKey): Entry => ({
  href: `/demandes?produit=${product}`,
  label: 'Demandes',
  permission: 'demandes.traiter',
  counter: 'pending',
  product,
})

// Le menu est rangé par produit, tel que l'accueil les vend (ADR 046) : chaque
// rayon réunit le planning, les demandes, le parc et les états des lieux de son
// produit. « Au quotidien » garde les vues d'ensemble, les réglages sont en bas.
// La facturation est partie dans Dolibarr (ADR 046) : elle n'a plus d'entrée.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
const groups: { label: string; entries: Entry[] }[] = [
  {
    label: 'Au quotidien',
    entries: [
      { href: '/reservations', label: 'Planning général', permission: 'reservations.gerer' },
      // Les demandes du site public bloquent un créneau tant qu'elles ne sont
      // pas traitées (ADR 005) : leur nombre est affiché en permanence.
      { href: '/demandes', label: 'Toutes les demandes', permission: 'demandes.traiter', counter: 'pending' },
      // Devis que Dolibarr vient chercher (ADR 043).
      { href: '/devis', label: 'Devis', permission: 'demandes.traiter' },
      // Entrées et sorties des ressources occupées ; les modèles s'y rejoignent (ADR 039).
      { href: '/etats-des-lieux', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    label: 'Salles',
    entries: [
      { href: '/reservations?type=salle', label: 'Planning des salles', permission: 'reservations.gerer' },
      requests('salles'),
      { href: '/ressources?type=salle', label: 'Salles', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Bureaux',
    entries: [
      // Un bureau se loue au mois : la vue du mois montre son occupation.
      {
        href: '/reservations/mois?type=bureau',
        match: '/reservations?type=bureau',
        label: 'Occupation des bureaux',
        permission: 'reservations.gerer',
      },
      requests('bureaux'),
      { href: '/ressources?type=bureau', label: 'Bureaux', permission: 'ressources.gerer' },
      { href: '/ressources?type=casier', label: 'Casiers', permission: 'ressources.gerer' },
      { href: '/etats-des-lieux?produit=bureaux', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    label: 'Domiciliation',
    entries: [
      // Les demandes de courrier à traiter (ouverture, numérisation,
      // réexpédition) sont comptées : c'est une file d'attente (ADR 037).
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer', counter: 'mail' },
      // Une domiciliation ne réserve pas de créneau : sa demande est un devis (ADR 043).
      { href: '/devis?produit=domiciliation', label: 'Demandes', permission: 'demandes.traiter' },
      { href: '/ressources?type=boite_aux_lettres', label: 'Boîtes aux lettres', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Camion',
    entries: [
      // Le camion se loue à la demi-journée ou à la journée : la semaine d'abord.
      {
        href: '/reservations/semaine?type=vehicule',
        match: '/reservations?type=vehicule',
        label: 'Planning du camion',
        permission: 'reservations.gerer',
      },
      requests('vehicules'),
      { href: '/ressources?type=vehicule', label: 'Véhicules', permission: 'ressources.gerer' },
      { href: '/etats-des-lieux?produit=vehicules', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    // Consultables ici tant que la passerelle Dolibarr ne les fournit pas
    // (ADR 046, deuxième tranche).
    label: 'Clients',
    entries: [
      { href: '/clients', label: 'Clients', permission: 'clients.gerer' },
      { href: '/contrats', label: 'Contrats', permission: 'contrats.consulter' },
      { href: '/offres', label: 'Offres', permission: 'services.gerer' },
      { href: '/services', label: 'Services', permission: 'services.gerer' },
      { href: '/tarifs', label: 'Tarifs', permission: 'tarifs.gerer' },
    ],
  },
  {
    label: 'Le centre',
    entries: [
      { href: '/ressources', label: 'Toutes les ressources', permission: 'ressources.gerer' },
      { href: '/disponibilites', label: 'Disponibilités', permission: 'horaires.gerer' },
      { href: '/ressources/annonces', label: 'Annonces du site', permission: 'ressources.gerer' },
      { href: '/ressources/agendas', label: 'Agendas Google', permission: 'agenda-google.gerer' },
    ],
  },
  {
    label: 'Suivi',
    entries: [
      { href: '/indicateurs', label: 'Indicateurs', permission: 'indicateurs.consulter' },
      // Journal des messages envoyés ; les modèles s'ouvrent depuis lui (ADR 038).
      { href: '/notifications', label: 'Messages', permission: 'notifications.consulter' },
    ],
  },
  {
    label: 'Administration',
    entries: [
      { href: '/equipe', label: 'Équipe', permission: 'equipe.gerer' },
      // Comptes créés sur le site, dont les inscriptions libres (ADR 045).
      // L'accueil y rattache ; bannir est réservé à l'exploitant (`comptes.gerer`).
      { href: '/comptes', label: 'Comptes', permission: 'comptes.rattacher' },
      { href: '/configuration', label: 'Configuration', permission: 'centre.configurer' },
    ],
  },
]

/**
 * Navigation du back-office, rangée par catégories. Client parce que l'entrée
 * active dépend de l'URL courante ; le reste de la coque reste rendu sur le
 * serveur.
 */
export function Nav({
  pendingCount = 0,
  pendingByProduct = {},
  mailRequestCount = 0,
  allowed,
}: {
  pendingCount?: number
  /** Demandes en attente par produit, pour le compteur de chaque rayon. */
  pendingByProduct?: Partial<Record<ProductKey, number>>
  mailRequestCount?: number
  /** Droits du membre connecté (`permissionsOf`). */
  allowed: readonly Permission[]
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // La navigation est rendue deux fois (barre latérale, menu des écrans
  // étroits) : les identifiants des titres doivent rester uniques.
  const prefix = useId()

  // Une catégorie dont aucune entrée n'est permise disparaît avec son titre.
  const visibles = groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => allowed.includes(entry.permission)),
    }))
    .filter((group) => group.entries.length > 0)

  const pattern = (entry: Entry) => entry.match ?? entry.href
  const actif = activeEntry(
    visibles.flatMap((group) => group.entries.map(pattern)),
    pathname,
    new URLSearchParams(searchParams.toString()),
  )

  const counts = { pending: pendingCount, mail: mailRequestCount }

  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-5">
      {visibles.map((group) => {
        const titleId = `${prefix}-${group.label.replace(/\s+/g, '-')}`
        return (
          <div key={group.label} role="group" aria-labelledby={titleId}>
            <p
              id={titleId}
              className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.entries.map((entry) => {
                const active = pattern(entry) === actif
                const count =
                  entry.counter === 'pending' && entry.product
                    ? (pendingByProduct[entry.product] ?? 0)
                    : entry.counter
                      ? counts[entry.counter]
                      : 0
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      aria-current={active ? 'page' : undefined}
                      // L'entrée active ne se lit pas qu'à la couleur : graisse
                      // et filet à gauche la distinguent aussi.
                      className={`flex items-center justify-between gap-2 rounded-sm border-l-[3px] px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                        active
                          ? 'border-primary bg-accent/10 font-semibold text-primary'
                          : 'border-transparent font-medium text-foreground/80 hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span>{entry.label}</span>
                      {count > 0 && (
                        <span
                          className="rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular"
                          aria-label={
                            entry.counter === 'pending'
                              ? `${count} demande${count > 1 ? 's' : ''} en attente`
                              : `${count} demande${count > 1 ? 's' : ''} de courrier à traiter`
                          }
                        >
                          {count}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
