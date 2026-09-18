import Image from 'next/image'
import Link from 'next/link'

import { currentTenant } from '../../lib/tenant.ts'
import { formatOpeningSummary } from '../../modules/ressources/ouverture.ts'
import { listOpeningHours } from '../../modules/ressources/ouverture-queries.ts'

/**
 * Coque du site public.
 *
 * Tout ce qui identifie le centre — nom, signature, logo, adresse, téléphone —
 * vient de la table `tenants` et non du code : c'est ce qui change d'un centre
 * à l'autre (décision 1). Voir `infra/configurer-centre.mjs`.
 */
export default async function PortailLayout({ children }: { children: React.ReactNode }) {
  const [tenant, regles] = await Promise.all([currentTenant(), listOpeningHours()])
  // Les horaires affichés viennent des mêmes lignes que les créneaux libres :
  // une page qui annonce une ouverture que le calendrier refuse est un piège.
  const ouverture = formatOpeningSummary(regles)

  const adresse = [tenant.addressLine1, tenant.addressLine2].filter(Boolean).join(', ')
  const ville = [tenant.postalCode, tenant.city].filter(Boolean).join(' ')

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            {tenant.logoPath ? (
              // Servi depuis notre domaine : une image appelée chez le site
              // vitrine livrerait l'IP de chaque visiteur à un tiers (ADR 004).
              <Image
                src={tenant.logoPath}
                alt={tenant.name}
                width={600}
                height={191}
                priority
                className="h-9 w-auto"
              />
            ) : (
              <span className="text-lg font-semibold tracking-tight text-secondary">
                {tenant.name}
              </span>
            )}
          </Link>

          <div className="flex items-center gap-2">
            {tenant.phone && (
              <a
                href={`tel:${tenant.phone.replace(/\s/g, '')}`}
                className="hidden rounded-md px-3 py-2 text-sm font-medium text-secondary transition-colors hover:bg-muted sm:block"
              >
                {tenant.phone}
              </a>
            )}
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
        <div className="mx-auto grid max-w-[1200px] gap-8 px-5 py-12 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <p className="text-lg font-semibold text-secondary">{tenant.name}</p>
            {tenant.tagline && (
              <p className="mt-1 text-sm text-muted-foreground">{tenant.tagline}</p>
            )}
          </div>

          <div className="text-sm">
            <p className="font-medium text-secondary">Nous trouver</p>
            <address className="mt-2 not-italic text-muted-foreground">
              {adresse && <span className="block">{adresse}</span>}
              {ville && <span className="block">{ville}</span>}
            </address>
          </div>

          <div className="text-sm">
            <p className="font-medium text-secondary">Nous joindre</p>
            <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
              {tenant.phone && (
                <a
                  href={`tel:${tenant.phone.replace(/\s/g, '')}`}
                  className="underline-offset-2 hover:underline"
                >
                  {tenant.phone}
                </a>
              )}
              {tenant.email && (
                <a href={`mailto:${tenant.email}`} className="underline-offset-2 hover:underline">
                  {tenant.email}
                </a>
              )}
              {tenant.websiteUrl && (
                <a
                  href={tenant.websiteUrl}
                  className="underline-offset-2 hover:underline"
                  rel="noreferrer"
                >
                  {tenant.websiteUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>

          <div className="text-sm">
            <p className="font-medium text-secondary">Horaires</p>
            <p className="mt-2 text-muted-foreground">
              {ouverture ?? 'Nous contacter pour connaître les horaires.'}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Heures affichées en {tenant.timezone}.
            </p>
          </div>
        </div>

        <div className="border-t border-border">
          <div className="mx-auto max-w-[1200px] px-5 py-5 text-xs text-muted-foreground sm:px-8">
            {tenant.legalName && (
              <p>
                {tenant.name} est exploité par {tenant.legalName}.
              </p>
            )}
            {/* Espace client et mentions légales arrivent avec le portail
                authentifié ; l'accès équipe existe déjà. */}
            <Link href="/auth/connexion" className="underline-offset-2 hover:underline">
              Accès équipe
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
