import type { Permission } from '../../../lib/auth/permissions.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'
import { products, type ProductKey } from '../../../modules/ressources/produits.ts'

/**
 * Ce que la page « Réglages » réunit (ADR 048) : les écrans qu'on ouvre pour
 * paramétrer le centre, pas pour traiter une demande. Ils sortent du menu, qui
 * ne garde que ce qui se traite au quotidien (ADR 053).
 *
 * Rangés par service vendu (ADR 082), comme le menu : un groupe par produit de
 * `produits.ts` (Salles, Bureaux, Domiciliation, Camion, Matériel), puis
 * « Tous les services » et « Le centre ».
 *
 * **Ajouter un réglage** : une ligne dans `reglagesLinks`, avec son `service`.
 * Rien d'autre à toucher : la page le range sous son service, le rayon du
 * menu gagne sa ligne « Réglages » (`/reglages?produit=…`) et s'allume sur
 * l'écran du réglage. Un réglage qui ne vaut que pour un produit (un
 * questionnaire, des formules, des expéditeurs, des pièces…) va sous ce
 * produit ; ce qui vaut pour tous sous `tous` ; ce qui règle le centre
 * lui-même (équipe, identité, CRM) sous `centre`.
 *
 * Chaque lien porte le droit de sa page (ADR 019) : la page n'affiche que ceux
 * du rôle, et le menu ne montre « Réglages » qu'à qui en a au moins un.
 */
export type ReglagesService = ProductKey | 'tous' | 'centre'

/** Les groupes de la page, dans l'ordre du menu : les rayons, puis ce qui sert à tous, puis le centre. */
export const reglagesServices: readonly { key: ReglagesService; title: string }[] = [
  ...products.map((product) => ({ key: product.key, title: product.label })),
  { key: 'tous', title: 'Tous les services' },
  { key: 'centre', title: 'Le centre' },
]

export type ReglagesLink = {
  /** Le service sous lequel le réglage se range : un produit, `tous` ou `centre`. */
  service: ReglagesService
  href: string
  label: string
  description: string
  permission: Permission
}

/**
 * Modèles d'état des lieux, un par type de ressource (ADR 039) : chacun sous
 * le produit de son type, tiré de `produits.ts` — un type ajouté à un produit
 * y amène son modèle.
 */
const inspectionTemplates: ReglagesLink[] = products.flatMap((product) =>
  product.types.map((type) => ({
    service: product.key,
    href: `/etats-des-lieux/modeles/${type}`,
    label: `Modèle d’état des lieux : ${resourceTypeLabels[type].toLocaleLowerCase('fr-FR')}`,
    description: 'Les champs à relever à l’entrée et à la sortie, et leurs versions publiées.',
    permission: 'etats-des-lieux.modeles' as const,
  })),
)

export const reglagesLinks: readonly ReglagesLink[] = [
  // — Un seul service : sous son produit. —
  ...inspectionTemplates,
  // Formulaire de demande du site, un par service (ADR 074).
  ...([
    ['salles', 'salle'],
    ['bureaux', 'bureau'],
    ['domiciliation', 'domiciliation'],
    ['vehicules', 'vehicule'],
    ['materiel', 'materiel'],
  ] as const).map(([service, formulaire]) => ({
    service,
    href: `/reglages/formulaires/${formulaire}`,
    label: 'Formulaire de demande',
    description: 'Les questions posées sur le site, leur ordre, ce qui est obligatoire et ce qui s’affiche selon les réponses.',
    permission: 'formulaires.gerer' as const,
  })),
  // Expéditeurs proposés à la saisie du courrier (ADR 079).
  {
    service: 'domiciliation',
    href: '/courrier/expediteurs',
    label: 'Expéditeurs proposés',
    description: 'La liste des expéditeurs suggérés à la saisie du courrier, dans l’ordre choisi.',
    permission: 'centre.configurer',
  },
  // Pièces justificatives demandées au domicilié (ADR 075).
  {
    service: 'domiciliation',
    href: '/reglages/pieces',
    label: 'Pièces justificatives',
    description: 'Les pièces que le client dépose dans son espace, selon la situation de sa société.',
    permission: 'centre.configurer',
  },

  // — Tous les services. —
  {
    service: 'tous',
    href: '/offres',
    label: 'Offres',
    description: 'Les formules vendues : domiciliation, bureau au mois, et ce qu’elles comprennent.',
    permission: 'services.gerer',
  },
  {
    service: 'tous',
    href: '/services',
    label: 'Services',
    description: 'Ce qui se vend à part : numérisation, réexpédition, standard, options.',
    permission: 'services.gerer',
  },
  {
    service: 'tous',
    href: '/tarifs',
    label: 'Tarifs',
    description: 'Les prix des salles, bureaux et du camion, à l’heure, à la demi-journée, à la journée.',
    permission: 'tarifs.gerer',
  },
  // Chaque ressource se relie à un agenda, le camion compris (ADR 072, ADR 064).
  {
    service: 'tous',
    href: '/ressources/agendas',
    label: 'Agendas Google',
    description: 'Le planning de chaque ressource recopié dans un agenda Google.',
    permission: 'agenda-google.gerer',
  },
  // Cloche de l'espace client (ADR 077).
  {
    service: 'tous',
    href: '/notifications/cloche-client',
    label: 'Cloche de l’espace client',
    description: 'Les nouveautés que la cloche annonce aux clients dans leur espace, et combien de jours elle les garde.',
    permission: 'notifications.gerer',
  },

  // — Le centre. —
  {
    service: 'centre',
    href: '/disponibilites',
    label: 'Horaires et fermetures',
    description: 'Les heures d’ouverture et les jours fermés, par ressource.',
    permission: 'horaires.gerer',
  },
  {
    service: 'centre',
    href: '/indicateurs',
    label: 'Indicateurs',
    description: 'Occupation des ressources et activité du centre.',
    permission: 'indicateurs.consulter',
  },
  {
    service: 'centre',
    href: '/equipe',
    label: 'Équipe',
    description: 'Les membres de l’équipe et leur rôle : exploitant ou accueil.',
    permission: 'equipe.gerer',
  },
  {
    service: 'centre',
    href: '/configuration',
    label: 'Configuration',
    description: 'Identité du centre, règles de réservation, durées de conservation.',
    permission: 'centre.configurer',
  },
  // Réservé à la direction (ADR 065).
  {
    service: 'centre',
    href: '/reglages/crm',
    label: 'Connexion au CRM',
    description: 'Le CRM du centre, son jeton d’accès, les flux échangés et le journal des échanges.',
    permission: 'crm.gerer',
  },
]

/** Les réglages d'un service, dans l'ordre de `reglagesLinks`. */
export function reglagesOf(service: ReglagesService): ReglagesLink[] {
  return reglagesLinks.filter((link) => link.service === service)
}

/** La page, groupe par groupe ; un groupe sans réglage n'y paraît pas. */
export const reglagesSections: readonly { key: ReglagesService; title: string; links: readonly ReglagesLink[] }[] =
  reglagesServices
    .map((service) => ({ ...service, links: reglagesOf(service.key) }))
    .filter((section) => section.links.length > 0)

/** Adresse des réglages d'un produit, celle de la ligne « Réglages » de son rayon. */
export const reglagesHref = (product: ProductKey) => `/reglages?produit=${product}`

/** Les droits qui ouvrent au moins un des réglages donnés ; tous par défaut. */
export function permissionsOf(links: readonly ReglagesLink[] = reglagesLinks): Permission[] {
  return [...new Set(links.map((link) => link.permission))]
}

/** Les droits qui ouvrent au moins un réglage : ceux qui font paraître l'entrée du menu. */
export const reglagesPermissions: readonly Permission[] = permissionsOf()
