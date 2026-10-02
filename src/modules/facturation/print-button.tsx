'use client'

/**
 * Imprime la page : la feuille d'impression ne garde que le document. Le
 * navigateur propose aussi « Enregistrer au format PDF » : le PDF est cette
 * vue, sans bibliothèque (ADR 025, 026). Un seul bouton pour les contrats, les
 * factures et les relances.
 */
export function PrintButton({
  label = 'Imprimer',
  className = 'rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden',
}: {
  label?: string
  /** Remplace l'apparence par défaut : l'espace client veut une cible de 44 px (R25). */
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={className}
    >
      {label}
    </button>
  )
}
