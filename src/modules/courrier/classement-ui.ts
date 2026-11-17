/**
 * Constantes d'affichage de la boîte aux lettres partagées par la page
 * (composant serveur) et ses formulaires (composants client). Dans un module
 * sans `'use client'` : importée d'un tel module par un composant serveur,
 * une constante n'arrive pas en valeur mais en référence client.
 */

/** Identifiant du formulaire de sélection : les cases des cartes s'y rattachent (`form=`). */
export const SELECTION_FORM_ID = 'selection-courrier'

/** Bouton d'un geste de la carte d'un pli : tous au même rang visuel (ADR 078). */
export const quickButtonClass =
  'press inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-sm font-medium text-primary transition-colors hover:bg-muted disabled:opacity-50'

/** Choix « Ajouter une catégorie… » de la liste d'une carte : crée une catégorie à soi, puis y range le pli. */
export const NEW_CATEGORY_CHOICE = 'nouvelle'
