/**
 * Icônes de la boîte aux lettres du client (ADR 078), au trait de la charte
 * (outline 1,5 px, d'après Lucide). Décoratives : le sens est toujours porté
 * par le libellé à côté (`CLAUDE.md`, jamais la couleur ni l'icône seules).
 */
type IconProps = { size?: number; className?: string }

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
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  )
}

/** Ouvre un menu : « Demander ▾ ». */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

/** Filtres repliés de la boîte aux lettres (Lucide « funnel »). */
export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
    </Svg>
  )
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </Svg>
  )
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M18.5 12.5 12 19l-6.5-6.5" />
    </Svg>
  )
}

/** Catégorie masquée. */
export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.7 5.1A10.8 10.8 0 0 1 12 5c5 0 8.5 4.6 9.5 7a13 13 0 0 1-1.7 2.8" />
      <path d="M6.6 6.6C4.5 8 3 10.1 2.5 12c1 2.4 4.5 7 9.5 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </Svg>
  )
}

/** Pli ignoré : mis de côté, comme une archive. */
export function ArchiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4" />
    </Svg>
  )
}

/** Adresse par défaut. */
export function StarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
    </Svg>
  )
}
