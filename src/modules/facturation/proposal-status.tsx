import { ArrowRightIcon, CheckIcon, ClockIcon, MailIcon } from '../../components/ui/icons.tsx'
import { proposalStatusLabels } from './propositions.ts'
import type { ProposalStatus } from './schema-devis.ts'

/**
 * État d'un devis : un libellé et une icône, sur les bleus de marque
 * (`--statut-*`), jamais un code vert/rouge (`CLAUDE.md`). La couleur ne
 * porte jamais seule le sens : le texte le dit.
 */
const styles: Record<ProposalStatus, string> = {
  // À l'accueil d'agir : contour bleu clair, fond blanc.
  draft: 'border border-statut-reserve bg-white text-primary',
  // En attente de Dolibarr.
  ready: 'border border-statut-reserve/30 bg-statut-reserve/15 text-primary',
  // Dans Dolibarr.
  sent: 'border border-statut-confirme/20 bg-statut-confirme/10 text-statut-confirme',
  accepted: 'border border-statut-confirme bg-statut-confirme text-white',
  refused: 'border border-border bg-statut-annule text-foreground',
  cancelled: 'border border-border bg-statut-annule text-muted-foreground',
}

function CrossIcon({ size = 16 }: { size?: number }) {
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
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function StatusIcon({ status }: { status: ProposalStatus }) {
  switch (status) {
    case 'draft':
      return <ClockIcon size={16} />
    case 'ready':
      return <ArrowRightIcon size={16} />
    case 'sent':
      return <MailIcon size={16} />
    case 'accepted':
      return <CheckIcon size={16} />
    default:
      return <CrossIcon size={16} />
  }
}

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      <StatusIcon status={status} />
      {proposalStatusLabels[status]}
    </span>
  )
}
