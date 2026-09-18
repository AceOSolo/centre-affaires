import Link from 'next/link'

import { currentTenant } from '../../lib/tenant.ts'

/**
 * Coque du site public.
 *
 * Direction artistique Secutop : bleus de marque, Rubik, rayons généreux,
 * aucune couleur hors palette. Volontairement séparée de la coque du
 * back-office, qui est un outil de travail dense — l'ADR 004 prévoit que les
 * deux interfaces divergent.
 */
export default async function PortailLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link href="/" className="text-lg font-semibold tracking-tight text-secondary">
            {tenant.name}
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="#disponibilites"
              className="hidden rounded-md px-3 py-2 text-sm font-medium text-secondary transition-colors hover:bg-muted sm:block"
            >
              Disponibilités
            </Link>
            <Link
              href="#demande"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Réserver
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border bg-muted">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-2 px-5 py-8 text-sm text-muted-foreground sm:px-8">
          <p className="font-medium text-secondary">{tenant.name}</p>
          <p>
            Salles de réunion, bureaux et services aux entreprises. Horaires affichés en{' '}
            {tenant.timezone}.
          </p>
          {/* Espace client et mentions légales arrivent avec l'authentification. */}
        </div>
      </footer>
    </div>
  )
}
