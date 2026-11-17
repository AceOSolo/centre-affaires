import Link from 'next/link'

const pages = [
  { key: 'compte', href: '/compte/mon-compte', label: 'Mes informations' },
  { key: 'notifications', href: '/compte/preferences', label: 'Mes notifications' },
] as const

/**
 * « Mon compte » en deux pages (ADR 077) : ce qui concerne la personne — nom,
 * téléphone, adresse, mot de passe — d'un côté, les courriels qu'elle reçoit
 * de l'autre. La page en cours est dite par `aria-current`, pas par la seule
 * couleur.
 */
export function ParametresNav({ actif }: { actif: (typeof pages)[number]['key'] }) {
  return (
    <nav aria-label="Mon compte" className="flex flex-wrap gap-2">
      {pages.map((page) => {
        const current = page.key === actif
        return (
          <Link
            key={page.key}
            href={page.href}
            aria-current={current ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-xl border px-4 text-sm font-medium transition-colors ${
              current
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-white text-muted-foreground hover:text-primary'
            }`}
          >
            {page.label}
          </Link>
        )
      })}
    </nav>
  )
}
