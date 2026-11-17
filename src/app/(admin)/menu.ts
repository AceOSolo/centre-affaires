import type { Permission } from '../../lib/auth/permissions.ts'
import type { ProductKey } from '../../modules/ressources/produits.ts'
import { demandesPermissions, todayPermissions, type InboxShelf } from './aujourdhui/journee.ts'
import { permissionsOf, reglagesHref, reglagesOf, reglagesPermissions } from './reglages/sections.ts'

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
   * Demandes à traiter que l'entrée compte (`inboxCountsByShelf`, ADR 070) :
   * celles de son rayon. Plié, le rayon les garde à son titre.
   */
  counter?: InboxShelf
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
// (ADR 048), s'ouvre par rayon : chacun a sa ligne « Demandes », filtrée sur son
// produit et comptée, « Tous les services » ses « Autres demandes » (offres
// groupées, devis sans ressource) ; la cloche de l'en-tête en dit le total
// (ADR 070). Pas de « Demandes » générale au menu : la cloche y mène.
// Chaque rayon finit sur ses « Réglages », ceux de son seul produit (ADR 082) ;
// « Réglages », en bas, réunit la page entière.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
export type MenuGroup = { label: string; entries: MenuEntry[] }

/** La ligne « Demandes » d'un rayon : la page filtrée sur son produit, et son compteur. */
const demandes = (shelf: InboxShelf, permission: MenuEntry['permission'] = 'demandes.traiter'): MenuEntry => ({
  href: `/demandes?produit=${shelf}`,
  label: shelf === 'autres' ? 'Autres demandes' : 'Demandes',
  permission,
  counter: shelf,
})

/**
 * La ligne « Réglages » d'un rayon (ADR 082) : les réglages de son seul
 * produit (`reglages/sections.ts`), s'il en a — sinon rien. Elle s'allume sur
 * chacun de ses écrans ; le rôle la voit s'il a le droit de l'un d'eux.
 */
const reglages = (product: ProductKey): MenuEntry[] => {
  const links = reglagesOf(product)
  if (links.length === 0) return []
  return [
    {
      href: reglagesHref(product),
      label: 'Réglages',
      permission: permissionsOf(links),
      also: links.map((link) => link.href),
    },
  ]
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
    entries: [
      demandes('salles'),
      { href: '/reservations?type=salle', label: 'Planning des salles', permission: 'reservations.gerer' },
      { href: '/ressources?type=salle', label: 'Salles', permission: 'ressources.gerer' },
      ...reglages('salles'),
    ],
  },
  {
    label: 'Bureaux',
    entries: [
      demandes('bureaux'),
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
      ...reglages('bureaux'),
    ],
  },
  {
    label: 'Domiciliation',
    entries: [
      // Demandes de domiciliation et de courrier (ADR 057) : l'un ou l'autre droit l'ouvre.
      demandes('domiciliation', demandesPermissions),
      // L'historique des demandes de courrier (`/courrier/demandes`) allume cette entrée.
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer' },
      { href: '/ressources?type=boite_aux_lettres', label: 'Boîtes aux lettres', permission: 'ressources.gerer' },
      // Message libre aux domiciliés — fermeture, travaux… — et son historique (ADR 060).
      { href: '/messages', label: 'Messages aux domiciliés', permission: 'notifications.diffuser' },
      ...reglages('domiciliation'),
    ],
  },
  {
    label: 'Camion',
    entries: [
      demandes('vehicules'),
      // Le camion se loue à la demi-journée ou à la journée : la semaine d'abord.
      {
        href: '/reservations/semaine?type=vehicule',
        label: 'Planning du camion',
        permission: 'reservations.gerer',
        also: ['/reservations?type=vehicule'],
      },
      { href: '/ressources?type=vehicule', label: 'Véhicules', permission: 'ressources.gerer' },
      { href: '/etats-des-lieux?produit=vehicules', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
      ...reglages('vehicules'),
    ],
  },
  {
    // Télévision, climatisation… loués seuls ou en option d'une salle
    // (ADR 062) : chaque appareil a son planning, la semaine d'abord comme le
    // camion. Ses états des lieux se trouvent par la pastille « Matériel ».
    label: 'Matériel',
    entries: [
      demandes('materiel'),
      {
        href: '/reservations/semaine?type=materiel',
        label: 'Planning du matériel',
        permission: 'reservations.gerer',
        also: ['/reservations?type=materiel'],
      },
      { href: '/ressources?type=materiel', label: 'Appareils', permission: 'ressources.gerer' },
      ...reglages('materiel'),
    ],
  },
  {
    label: 'Tous les services',
    entries: [
      // Les offres groupées et les devis sans ressource n'ont pas de rayon.
      demandes('autres'),
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
        // La page entière (tous les groupes) ; elle s'allume sur les écrans de
        // « Tous les services » et du « Centre », ceux d'un produit allumant
        // la ligne « Réglages » de son rayon.
        permission: reglagesPermissions,
        also: [...reglagesOf('tous'), ...reglagesOf('centre')].map((link) => link.href),
      },
    ],
  },
]
