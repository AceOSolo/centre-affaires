'use client'

/**
 * Impression du document par le navigateur, qui propose aussi
 * « Enregistrer au format PDF » : le PDF est cette vue, sans bibliothèque
 * (ADR 025).
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
    >
      Imprimer ou enregistrer en PDF
    </button>
  )
}
