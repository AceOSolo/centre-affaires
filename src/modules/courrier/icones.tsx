import { CheckIcon, ClockIcon, FileTextIcon, MailIcon } from '../../components/ui/icons.tsx'
import type { MailKind, MailRequestKind, MailRequestStatus } from './schema.ts'

/**
 * Icônes propres au courrier, au trait de la charte (outline 1,5 px, d'après
 * Lucide) : type de pli, nature et état d'une demande. Décoratives — le sens
 * est toujours porté par le libellé à côté (`CLAUDE.md`, jamais la couleur ni
 * l'icône seules).
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

/** Colis. */
export function PackageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <path d="m3.3 7 7.7 4.7a2 2 0 0 0 2 0L20.7 7" />
      <path d="m7.5 4.27 9 5.15" />
    </Svg>
  )
}

/** Recommandé : un pli remis contre signature. */
export function RegisteredIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  )
}

/** Réexpédition. */
export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.54 21.69a.5.5 0 0 0 .93-.03l6.5-19a.5.5 0 0 0-.63-.63l-19 6.5a.5.5 0 0 0-.03.93l7.93 3.18a2 2 0 0 1 1.11 1.11z" />
      <path d="m21.85 2.15-10.94 10.94" />
    </Svg>
  )
}

/** Numérisation. */
export function ScanIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </Svg>
  )
}

/** En cours : le centre s'en occupe. */
export function HourglassIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22" />
      <path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />
    </Svg>
  )
}

/** Refusée. */
export function CircleXIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </Svg>
  )
}

/** Annulée. */
export function BanIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </Svg>
  )
}

export const mailKindIcons: Record<MailKind, (props: IconProps) => React.ReactNode> = {
  lettre: MailIcon,
  recommande: RegisteredIcon,
  colis: PackageIcon,
  autre: FileTextIcon,
}

export const mailRequestKindIcons: Record<MailRequestKind, (props: IconProps) => React.ReactNode> = {
  open_and_scan: ScanIcon,
  scan: ScanIcon,
  forward: SendIcon,
}

export const mailRequestStatusIcons: Record<MailRequestStatus, (props: IconProps) => React.ReactNode> = {
  requested: ClockIcon,
  in_progress: HourglassIcon,
  done: CheckIcon,
  refused: CircleXIcon,
  cancelled: BanIcon,
}
