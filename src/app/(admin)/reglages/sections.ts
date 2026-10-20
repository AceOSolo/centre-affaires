import type { Permission } from '../../../lib/auth/permissions.ts'

/**
 * Ce que la page « Réglages » réunit (ADR 048) : les écrans qu'on ouvre pour
 * paramétrer le centre, pas pour traiter une demande. Ils sortent du menu, qui
 * ne garde que le parcours d'une demande.
 *
 * Chaque lien porte le droit de sa page (ADR 019) : la page n'affiche que ceux
 * du rôle, et le menu ne montre « Réglages » qu'à qui en a au moins un.
 */
export type ReglagesLink = { href: string; label: string; description: string; permission: Permission }

export const reglagesSections: readonly { title: string; links: readonly ReglagesLink[] }[] = [
  {
    title: 'Catalogue et tarifs',
    links: [
      {
        href: '/offres',
        label: 'Offres',
        description: 'Les formules vendues : domiciliation, bureau au mois, et ce qu’elles comprennent.',
        permission: 'services.gerer',
      },
      {
        href: '/services',
        label: 'Services',
        description: 'Ce qui se vend à part : numérisation, réexpédition, standard, options.',
        permission: 'services.gerer',
      },
      {
        href: '/tarifs',
        label: 'Tarifs',
        description: 'Les prix des salles, bureaux et du camion, à l’heure, à la demi-journée, à la journée.',
        permission: 'tarifs.gerer',
      },
    ],
  },
  {
    title: 'Le centre',
    links: [
      {
        href: '/disponibilites',
        label: 'Horaires et fermetures',
        description: 'Les heures d’ouverture et les jours fermés, par ressource.',
        permission: 'horaires.gerer',
      },
      {
        href: '/ressources/agendas',
        label: 'Agendas Google',
        description: 'Le planning de chaque ressource recopié dans un agenda Google.',
        permission: 'agenda-google.gerer',
      },
      {
        href: '/indicateurs',
        label: 'Indicateurs',
        description: 'Occupation des ressources et activité du centre.',
        permission: 'indicateurs.consulter',
      },
    ],
  },
  {
    title: 'Équipe et configuration',
    links: [
      {
        href: '/equipe',
        label: 'Équipe',
        description: 'Les membres de l’équipe et leur rôle : exploitant ou accueil.',
        permission: 'equipe.gerer',
      },
      {
        href: '/configuration',
        label: 'Configuration',
        description: 'Identité du centre, règles de réservation, durées de conservation.',
        permission: 'centre.configurer',
      },
    ],
  },
]

/** Les droits qui ouvrent au moins un réglage : ceux qui font paraître l'entrée du menu. */
export const reglagesPermissions: readonly Permission[] = [
  ...new Set(reglagesSections.flatMap((section) => section.links.map((link) => link.permission))),
]
