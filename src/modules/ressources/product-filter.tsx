import Link from 'next/link'

import { products, type Product, type ProductKey } from './produits.ts'

/**
 * Pastilles « Tous / Salles / Bureaux / … » d'une liste rangeable par produit
 * (ADR 046). `href` construit l'adresse de chaque pastille, les autres filtres
 * de la page conservés ; `only` limite aux produits qui ont un sens pour la
 * liste (pas de demande de réservation pour une domiciliation).
 */
export function ProductFilter({
  active,
  href,
  only,
}: {
  active: Product | undefined
  href: (product: ProductKey | undefined) => string
  only?: readonly ProductKey[]
}) {
  const shown = only ? products.filter((product) => only.includes(product.key)) : products
  const choices = [{ key: undefined, label: 'Tous les produits' }, ...shown]

  return (
    <nav aria-label="Filtrer par produit" className="flex flex-wrap gap-2">
      {choices.map((choice) => {
        const current = active?.key === choice.key
        return (
          <Link
            key={choice.key ?? 'tous'}
            href={href(choice.key)}
            aria-current={current ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              current
                ? 'border-primary bg-primary text-white'
                : 'border-border bg-white text-foreground hover:bg-muted'
            }`}
          >
            {choice.label}
          </Link>
        )
      })}
    </nav>
  )
}
