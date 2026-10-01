import { staffRoleLabels, type StaffRole } from '../../db/staff.ts'

/**
 * Matrice des droits de l'équipe (R27, ADR 019).
 *
 * Elle vit dans le code, pas en base : c'est une frontière de sécurité, relue
 * comme le reste du code, pas une configuration que l'on modifie à l'écran.
 * La RLS ne distingue pas l'exploitant de l'accueil ; c'est la garde
 * `requirePermission()` (`staff.ts`), appelée dans chaque page et chaque action
 * serveur du back-office, qui refuse ce que le rôle ne permet pas.
 *
 * Répartition : l'accueil tient l'opérationnel du quotidien — planning,
 * demandes, courrier, fiches clients ; l'exploitant fait tout, dont les tarifs,
 * les contrats, l'équipe et la configuration du centre.
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
  'tarifs.gerer',
  'ressources.gerer',
  'horaires.gerer',
  'centre.configurer',
  'agenda-google.gerer',
  'equipe.gerer',
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
  'tarifs.gerer': 'Grilles tarifaires',
  'ressources.gerer': 'Ressources et annonces du site public',
  'horaires.gerer': 'Horaires d’ouverture et fermetures',
  'centre.configurer': 'Configuration du centre : règles de réservation, conservation',
  'agenda-google.gerer': 'Agendas Google',
  'equipe.gerer': 'Équipe : inscrire, changer un rôle, retirer',
}

/** Droits de l'accueil : l'opérationnel du quotidien. */
const accueil: readonly Permission[] = [
  'reservations.gerer',
  'demandes.traiter',
  'clients.gerer',
  'courrier.gerer',
  'contrats.consulter',
]

/**
 * La matrice : `admin` est l'exploitant, `staff` l'accueil (ADR 019). Toute
 * valeur de `staff_role` y figure — le `Record` le fait vérifier par le
 * compilateur le jour où un rôle s'ajoute.
 */
export const rolePermissions: Record<StaffRole, readonly Permission[]> = {
  admin: permissions,
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
