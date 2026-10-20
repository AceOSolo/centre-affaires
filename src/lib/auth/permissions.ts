import { staffRoleLabels, type StaffRole } from '../../db/staff.ts'

/**
 * Matrice des droits de l'équipe (R27, ADR 019).
 *
 * Elle vit dans le code, pas en base : c'est une frontière de sécurité, relue
 * comme le reste du code, pas une configuration que l'on modifie à l'écran.
 * La base ne distingue pas l'exploitant de l'accueil ; c'est la garde
 * `requirePermission()` (`staff.ts`), appelée dans chaque page et chaque action
 * serveur du back-office, qui refuse ce que le rôle ne permet pas.
 *
 * Répartition : l'accueil tient l'opérationnel du quotidien — planning,
 * demandes, courrier, fiches clients, lecture des contrats ; l'exploitant
 * fait tout, dont les tarifs, les services, les contrats et leurs avenants,
 * les indicateurs, l'équipe et la configuration du centre. La facturation,
 * les paiements et l'export comptable sont dans Dolibarr (ADR 046).
 *
 * Module pur, sans Next ni accès à la base : il s'éprouve seul
 * (`permissions.test.ts`). La coque du back-office en tire la liste des droits
 * du membre connecté, et la navigation masque ce qu'ils ne couvrent pas.
 */
export const permissions = [
  'reservations.gerer',
  'demandes.traiter',
  'clients.gerer',
  'clients.archiver',
  'courrier.gerer',
  'courrier.releve',
  'contrats.consulter',
  'contrats.creer',
  'contrats.activer',
  'contrats.resilier',
  'contrats.archiver',
  'contrats.avenants',
  'tarifs.gerer',
  'services.gerer',
  'souscriptions.gerer',
  'facturation.consulter',
  'facturation.gerer',
  'paiements.gerer',
  'comptabilite.exporter',
  'indicateurs.consulter',
  'ressources.gerer',
  'horaires.gerer',
  'centre.configurer',
  'agenda-google.gerer',
  'equipe.gerer',
  // Vague 3 (ADR 038 à 040) : ajoutés à la fin, la matrice n'est pas réordonnée.
  'notifications.consulter',
  'notifications.gerer',
  'etats-des-lieux.gerer',
  'etats-des-lieux.modeles',
  'rgpd.anonymiser',
  // Inscription libre (ADR 045) : ajouté à la fin, la matrice n'est pas réordonnée.
  'comptes.gerer',
  // L'accueil rattache un compte à son entreprise ; bannir reste à l'exploitant.
  'comptes.rattacher',
  // Tout membre peut ouvrir son propre espace client (ADR 045, révision).
  'espace-client.personnel',
] as const

export type Permission = (typeof permissions)[number]

/** Ce que chaque droit permet, tel que l'écran « Équipe » et l'ADR le disent. */
export const permissionLabels: Record<Permission, string> = {
  'reservations.gerer': 'Planning : créer, déplacer, annuler les réservations et les indisponibilités',
  'demandes.traiter': 'Valider ou refuser les demandes de réservation',
  'clients.gerer': 'Fiches clients et accès à l’espace client',
  'clients.archiver': 'Archiver une fiche client',
  'courrier.gerer': 'Enregistrer, ouvrir, retirer et consulter le courrier',
  'courrier.releve': 'Relevé mensuel des ouvertures et son export',
  'contrats.consulter': 'Consulter les contrats',
  'contrats.creer': 'Créer un contrat et modifier un brouillon',
  'contrats.activer': 'Activer un contrat',
  'contrats.resilier': 'Résilier un contrat',
  'contrats.archiver': 'Archiver un contrat',
  'contrats.avenants': 'Établir et signer un avenant, éditer les documents de contrat',
  'tarifs.gerer': 'Grilles tarifaires',
  'services.gerer': 'Catalogue de services et offres groupées',
  'souscriptions.gerer': 'Souscrire un client à un service, y mettre fin',
  'facturation.consulter': 'Consulter les factures, les avoirs et leurs paiements',
  'facturation.gerer': 'Facturer : brouillons, lots périodiques, émission, avoirs',
  'paiements.gerer': 'Pointer les paiements reçus, mandats de prélèvement SEPA',
  'comptabilite.exporter': 'Export comptable et plan de comptes',
  'indicateurs.consulter': 'Indicateurs : occupation, chiffre d’affaires, rentabilité',
  'ressources.gerer': 'Ressources et annonces du site public',
  'horaires.gerer': 'Horaires d’ouverture et fermetures',
  'centre.configurer':
    'Configuration du centre : règles de réservation, conservation, règles tarifaires, identité de facturation',
  'agenda-google.gerer': 'Agendas Google',
  'equipe.gerer': 'Équipe : inscrire, changer un rôle, retirer',
  'notifications.consulter': 'Consulter le journal des messages envoyés',
  'notifications.gerer': 'Modèles des messages envoyés aux clients et au centre',
  'etats-des-lieux.gerer': 'Saisir, photographier et clore les états des lieux',
  'etats-des-lieux.modeles': 'Modèles de formulaire des états des lieux',
  'rgpd.anonymiser': 'Anonymiser un client, un accès ou un membre retiré (RGPD)',
  'comptes.gerer': 'Comptes du site : bannir et réactiver',
  'comptes.rattacher': 'Comptes du site : consulter, rattacher à une entreprise',
  'espace-client.personnel': 'Ouvrir son propre espace client depuis le back-office',
}

/** Droits de l'accueil : l'opérationnel du quotidien. */
const accueil: readonly Permission[] = [
  'reservations.gerer',
  'demandes.traiter',
  'clients.gerer',
  'courrier.gerer',
  'contrats.consulter',
  // Dire à un client si un message est parti ; faire l'état des lieux d'une
  // entrée ou d'une sortie. Les modèles et l'anonymisation engagent le centre.
  'notifications.consulter',
  'etats-des-lieux.gerer',
  // Relier un compte inscrit en ligne à l'entreprise dont il relève (ADR 045).
  'comptes.rattacher',
  'espace-client.personnel',
]

/**
 * Droits de la facturation, tenue dans Dolibarr (ADR 046) : factures,
 * règlements, prélèvements, export comptable. Ils restent dans la liste — un
 * identifiant de droit ne se recycle pas —, mais aucun rôle ne les a plus :
 * les écrans du site renvoient à « Accès réservé », qui dit où aller.
 */
export const dolibarrPermissions: readonly Permission[] = [
  'facturation.consulter',
  'facturation.gerer',
  'paiements.gerer',
  'comptabilite.exporter',
]

/** Le droit est-il passé dans Dolibarr ? */
export function inDolibarr(permission: Permission): boolean {
  return dolibarrPermissions.includes(permission)
}

/**
 * La matrice : `admin` est l'exploitant, `staff` l'accueil (ADR 019). Toute
 * valeur de `staff_role` y figure — le `Record` le fait vérifier par le
 * compilateur le jour où un rôle s'ajoute.
 */
export const rolePermissions: Record<StaffRole, readonly Permission[]> = {
  admin: permissions.filter((permission) => !inDolibarr(permission)),
  staff: accueil,
}

/** Le rôle permet-il ce droit ? Un rôle inconnu ne permet rien. */
export function can(role: StaffRole | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return rolePermissions[role]?.includes(permission) ?? false
}

/** Tous les droits d'un rôle, pour la navigation. */
export function permissionsOf(role: StaffRole | null | undefined): Permission[] {
  return permissions.filter((permission) => can(role, permission))
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (permissions as readonly string[]).includes(value)
}

/** Libellés des rôles qui ont ce droit, pour dire à qui s'adresser. */
export function rolesAllowed(permission: Permission): string[] {
  return (Object.keys(rolePermissions) as StaffRole[])
    .filter((role) => can(role, permission))
    .map((role) => staffRoleLabels[role])
}
