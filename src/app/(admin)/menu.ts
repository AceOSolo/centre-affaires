import type { Permission } from '../../lib/auth/permissions.ts'
import { todayPermissions } from './aujourdhui/journee.ts'
import { reglagesPermissions, reglagesSections } from './reglages/sections.ts'

/**
 * Le menu du back-office (ADR 048), sans rendu : `nav.tsx` l'affiche,
 * `menu.test.ts` vérifie qu'aucun écran n'y paraît deux fois et que chaque
 * entrée mène à une page.
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
   * pages qu'il réunit (tarifs, équipe…).
   */
  also?: readonly string[]
}

// Le menu suit le parcours d'une demande (ADR 048) : ce qui arrive du client,
// la commande, l'administratif, la gestion au quotidien, puis ce qui repart
// vers le client. Une seule entrée par écran : le produit (salles, bureaux,
// domiciliation, camion) se choisit dans la page, par ses pastilles de filtre
// (ADR 046), et non par un rayon du menu qui répéterait chaque écran.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
export const menuGroups: { label: string; entries: MenuEntry[] }[] = [
  // Page d'arrivée de l'équipe (ADR 050) : ce qui attend, puis la journée.
  {
    label: 'Aujourd’hui',
    entries: [{ href: '/aujourdhui', label: 'Aujourd’hui', permission: todayPermissions }],
  },
  {
    label: 'Ce qui arrive',
    entries: [
      // Une seule boîte de réception : réservations à valider (elles bloquent
      // un créneau, ADR 005), devis à compléter (ADR 043), offres demandées.
      { href: '/demandes', label: 'Demandes', permission: 'demandes.traiter', counter: 'inbox' },
      { href: '/clients', label: 'Clients', permission: 'clients.gerer' },
    ],
  },
  {
    label: 'Commande',
    entries: [
      // Devis que Dolibarr vient chercher (ADR 043).
      { href: '/devis', label: 'Devis', permission: 'demandes.traiter' },
      { href: '/contrats', label: 'Contrats', permission: 'contrats.consulter' },
    ],
  },
  {
    label: 'Administratif',
    entries: [
      // Accès des clients à leur espace, dont les inscriptions libres (ADR 045).
      { href: '/comptes', label: 'Comptes du site', permission: 'comptes.rattacher' },
    ],
  },
  {
    label: 'Gestion',
    entries: [
      { href: '/reservations', label: 'Planning', permission: 'reservations.gerer' },
      // Les demandes de courrier à traiter sont comptées : c'est une file (ADR 037).
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer', counter: 'mail' },
      // Entrées et sorties des ressources occupées ; les modèles s'y rejoignent (ADR 039).
      { href: '/etats-des-lieux', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
      { href: '/ressources', label: 'Ressources', permission: 'ressources.gerer' },
    ],
  },
  {
    label: 'Retour client',
    entries: [
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
