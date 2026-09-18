/**
 * Icônes outline de la charte Secutop : trait de 1.5 px, coins arrondis, taille
 * homogène sur un même écran.
 *
 * Écrites à la main plutôt qu'importées d'une bibliothèque : le produit en
 * utilise une poignée, et `lucide-react` embarquerait un millier d'icônes pour
 * celles-ci. `CLAUDE.md` demande une justification à toute dépendance nouvelle —
 * il n'y en a pas ici.
 *
 * Aucun import depuis `src/modules/` : c'est la frontière que pose l'ADR 004
 * pour ce dossier.
 */
type IconProps = {
  /** Taille en pixels, identique pour toutes les icônes d'un même écran. */
  size?: number
  className?: string
}

function Svg({ size = 20, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Décoratives : le sens est toujours porté par le texte à côté.
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  )
}

export function UsersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="8" r="3.5" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
      <path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6" />
    </Svg>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </Svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5" />
    </Svg>
  )
}

export function BuildingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 20.5V5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15" />
      <path d="M15.5 9.5h2a2 2 0 0 1 2 2v9M3 20.5h18" />
      <path d="M8 8h3M8 12h3M8 16h3" />
    </Svg>
  )
}
