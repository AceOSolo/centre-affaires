'use client'

/** Imprime la page : la feuille d'impression ne garde que le document (vue imprimable, pas de PDF généré). */
export function PrintButton({ label = 'Imprimer' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden"
    >
      {label}
    </button>
  )
}
