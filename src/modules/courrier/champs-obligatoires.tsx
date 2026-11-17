/**
 * Astérisque des champs obligatoires et phrase qui l'explique, sur les
 * écrans du courrier côté client (recette du 17/11, règle commune).
 *
 * Le lot 1 de la même recette pose le composant commun du socle (ADR 004,
 * ADR 074), mené en parallèle : à la fusion, ces deux composants lui cèdent
 * la place. L'astérisque n'est pas la seule information : le contrôle porte
 * `required` et `aria-required`.
 */

/** Astérisque visuelle, à côté du libellé ; le contrôle porte `required`. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 font-semibold text-primary">
      *
    </span>
  )
}

/** La phrase qui explique l'astérisque, en tête de formulaire. */
export function RequiredNotice() {
  return (
    <p className="text-sm text-muted-foreground">
      Les champs marqués <span aria-hidden="true">*</span>
      <span className="sr-only">d’un astérisque</span> sont obligatoires.
    </p>
  )
}
