import type { Permission } from '../../lib/auth/permissions.ts'
import { todayPermissions } from './aujourdhui/journee.ts'
import { reglagesPermissions, reglagesSections } from './reglages/sections.ts'

/**
 * Le menu du back-office (ADR 053), sans rendu : `nav.tsx` l'affiche,
 * `menu.test.ts` vérifie que chaque rayon suit les produits de `produits.ts`
 * et que chaque entrée mène à une page.
 */

export type MenuEntry = {
  href: string
  label: string
  /** Droit de la page ; plusieurs : l'entrée s'affiche si le rôle en a un. */
  permission: Permission | readonly Permission[]
  /** Compteur de file d'attente affiché à côté du libellé. */
  counter?: 'inbox' | 'mail'
  /**
   * Autres adresses qui allument l'entrée : « Réglages » reste allumé sur les
   * pages qu'il réunit (tarifs, équipe…), le planning des bureaux sur ses vues
   * du jour et de la semaine.
   */
  also?: readonly string[]
}

// Le menu est rangé par service vendu (ADR 053) : un rayon par produit, dans
// l'ordre de `produits.ts`, avec le planning, le parc et ce qui se traite pour
// ce produit. Ce qui sert à tous les produits (clients, devis, contrats…) est
// réuni sous « Tous les services ». « Demandes » reste la seule boîte de
// réception (ADR 048) : le produit s'y choisit par les pastilles de la page.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
export const menuGroups: { label: string; entries: MenuEntry[] }[] = [
  // Page d'arrivée de l'équipe (ADR 050), puis tout ce qui attend l'accueil.
  {
    label: 'Aujourd’hui',
    entries: [
      { href: '/aujourdhui', label: 'Aujourd’hui', permission: todayPermissions },
      // Réservations à valider (elles bloquent un créneau, ADR 005), devis à
      // compléter (ADR 043), offres demandées : un seul compteur.
      { href: '/demandes', label: 'Demandes', permission: 'demandes.traiter', counter: 'inbox' },
    ],
  },
  {
    label: 'Salles',
    entries: [
      { href: '/reservations?type=salle', label: 'Planning des salles', permission: 'reservations.gerer' },
      { href: '/ressources?type=salle', label: 'Salles', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Bureaux',
    entries: [
      // Un bureau se loue au mois : le planning s'ouvre sur le mois.
      {
        href: '/reservations/mois?type=bureau',
        label: 'Planning des bureaux',
        permission: 'reservations.gerer',
        also: ['/reservations?type=bureau'],
      },
      // Les casiers font partie du produit (`produits.ts`) : leur liste allume la même entrée.
      {
        href: '/ressources?type=bureau',
        label: 'Bureaux',
        permission: 'ressources.gerer',
        also: ['/ressources?type=casier'],
      },
      // Entrées et sorties des bureaux occupés ; les modèles s'y rejoignent (ADR 039).
      { href: '/etats-des-lieux?produit=bureaux', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    label: 'Domiciliation',
    entries: [
      // Les demandes de courrier à traiter sont comptées : c'est une file (ADR 037).
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer', counter: 'mail' },
      { href: '/ressources?type=boite_aux_lettres', label: 'Boîtes aux lettres', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Camion',
    entries: [
      // Le camion se loue à la demi-journée ou à la journée : la semaine d'abord.
      {
        href: '/reservations/semaine?type=vehicule',
        label: 'Planning du camion',
        permission: 'reservations.gerer',
        also: ['/reservations?type=vehicule'],
      },
      { href: '/ressources?type=vehicule', label: 'Véhicules', permission: 'ressources.gerer' },
      { href: '/etats-des-lieux?produit=vehicules', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    label: 'Tous les services',
    entries: [
      { href: '/clients', label: 'Clients', permission: 'clients.gerer' },
      // Devis que Dolibarr vient chercher (ADR 043).
      { href: '/devis', label: 'Devis', permission: 'demandes.traiter' },
      { href: '/contrats', label: 'Contrats', permission: 'contrats.consulter' },
      // Accès des clients à leur espace, dont les inscriptions libres (ADR 045).
      { href: '/comptes', label: 'Comptes du site', permission: 'comptes.rattacher' },
      // Ce que le client a reçu : confirmations, courrier, factures… (ADR 038).
      { href: '/notifications', label: 'Messages envoyés', permission: 'notifications.consulter' },
      // Ce que le public voit du centre sur le site.
      { href: '/ressources/annonces', label: 'Annonces du site', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Réglages',
    entries: [
      {
        href: '/reglages',
        label: 'Réglages',
        permission: reglagesPermissions,
        also: reglagesSections.flatMap((section) => section.links.map((link) => link.href)),
      },
    ],
  },
]
