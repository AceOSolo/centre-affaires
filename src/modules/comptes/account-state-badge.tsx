import { BanIcon, CheckIcon } from '../../components/ui/icons.tsx'

/**
 * État d'un compte : une icône et un libellé, jamais la seule couleur. Un
 * compte banni n'est pas une erreur de saisie : la teinte reste celle de la
 * marque, le texte porte le sens.
 */
export function AccountStateBadge({ banned, label }: { banned: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        banned ? 'bg-primary text-primary-foreground' : 'bg-accent/15 text-primary'
      }`}
    >
      {banned ? <BanIcon size={14} /> : <CheckIcon size={14} />}
      {label}
    </span>
  )
}
