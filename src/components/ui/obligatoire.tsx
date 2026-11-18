import type { LabelHTMLAttributes, ReactNode } from 'react'

/**
 * Champs obligatoires (recette du 17/11, ADR 074) : l'astérisque commun à tous
 * les formulaires, et la phrase qui l'explique en tête du formulaire.
 *
 * L'astérisque n'est jamais la seule information : le contrôle porte
 * `required` (et `aria-required` quand le navigateur ne le déduit pas), que les
 * lecteurs d'écran annoncent. L'astérisque leur est donc masqué, pour ne pas
 * lire « étoile » à chaque champ. Bleu foncé de la charte, en gras : la charte
 * réserve le rouge aux erreurs, un champ obligatoire n'en est pas une.
 */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 font-semibold text-primary">
      *
    </span>
  )
}

/** « Les champs marqués * sont obligatoires », en tête du formulaire. */
export function RequiredNote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm text-muted-foreground ${className}`}>
      Les champs marqués <span aria-hidden="true" className="font-semibold text-primary">*</span>
      <span className="sr-only">d’un astérisque</span> sont obligatoires.
    </p>
  )
}

/** Libellé d'un champ, suivi de l'astérisque s'il est obligatoire. */
export function FieldLabel({
  required = false,
  children,
  ...props
}: { required?: boolean; children: ReactNode } & LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label {...props}>
      {children}
      {required && <RequiredMark />}
    </label>
  )
}
