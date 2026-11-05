import type { Permission } from '../../lib/auth/permissions.ts'
import { todayPermissions, type InboxShelf } from './aujourdhui/journee.ts'
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
// réuni sous « Tous les services ». « Demandes », la seule boîte de réception
// (ADR 048), n'est plus au menu : la cloche de l'en-tête en dit le nombre, en
// liste les plus récentes et y mène (ADR 070) ; le produit s'y choisit par les
// pastilles de la page.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
export type MenuGroup = {
  label: string
  /**
   * Les demandes à traiter que le titre du rayon compte (ADR 070) : celles de
   * son produit, ou « autres » pour « Tous les services ». Chaque rayon une
   * fois : leur somme est le nombre de la cloche.
   */
  inbox?: InboxShelf
  entries: MenuEntry[]
}

export const menuGroups: MenuGroup[] = [
  // Page d'arrivée de l'équipe (ADR 050). Ce qui attend l'accueil est dans la
  // cloche, qui mène à « Demandes » (ADR 070).
  {
    label: 'Aujourd’hui',
    entries: [{ href: '/aujourdhui', label: 'Aujourd’hui', permission: todayPermissions }],
  },
  {
    label: 'Salles',
    inbox: 'salles',
    entries: [
      { href: '/reservations?type=salle', label: 'Planning des salles', permission: 'reservations.gerer' },
      { href: '/ressources?type=salle', label: 'Salles', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Bureaux',
    inbox: 'bureaux',
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
    // Le titre compte les demandes de courrier et de domiciliation (ADR 057, ADR 070).
    inbox: 'domiciliation',
    entries: [
      // L'historique des demandes de courrier (`/courrier/demandes`) allume cette entrée.
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer' },
      { href: '/ressources?type=boite_aux_lettres', label: 'Boîtes aux lettres', permission: 'ressources.gerer' },
      // Message libre aux domiciliés — fermeture, travaux… — et son historique (ADR 060).
      { href: '/messages', label: 'Messages aux domiciliés', permission: 'notifications.diffuser' },
    ],
  },
  {
    label: 'Camion',
    inbox: 'vehicules',
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
    // Télévision, climatisation… loués seuls ou en option d'une salle
    // (ADR 062) : chaque appareil a son planning, la semaine d'abord comme le
    // camion. Ses états des lieux se trouvent par la pastille « Matériel ».
    label: 'Matériel',
    inbox: 'materiel',
    entries: [
      {
        href: '/reservations/semaine?type=materiel',
        label: 'Planning du matériel',
        permission: 'reservations.gerer',
        also: ['/reservations?type=materiel'],
      },
      { href: '/ressources?type=materiel', label: 'Appareils', permission: 'ressources.gerer' },
    ],
  },
  {
    // Les offres groupées et les devis sans ressource n'ont pas de rayon : ils comptent ici.
    label: 'Tous les services',
    inbox: 'autres',
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
