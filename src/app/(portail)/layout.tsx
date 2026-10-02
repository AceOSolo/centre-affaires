import Image from 'next/image'
import Link from 'next/link'

import { ArrowRightIcon, ClockIcon, MapPinIcon, PhoneIcon } from '../../components/ui/icons.tsx'
import { ScrollState } from '../../components/ui/scroll-state.tsx'
import { currentTenant } from '../../lib/tenant.ts'
import { formatOpeningSummary } from '../../modules/ressources/ouverture.ts'
import { listOpeningHours } from '../../modules/ressources/ouverture-queries.ts'
import { SectionNav } from './section-nav.tsx'

/** Ancres de la page d'accueil. Absolues : elles valent depuis n'importe où. */
const sections = [
  { href: '/#espaces', label: 'Nos espaces' },
  { href: '/#disponibilites', label: 'Disponibilités' },
  { href: '/#services', label: 'Services' },
  // Pas une ancre : l'accès des entreprises clientes à leur courrier (ADR 015).
  { href: '/compte', label: 'Espace client' },
]

/**
 * Rien n'est prérendu au build sur le site public, comme dans le back-office.
 *
 * Chaque page affiche des disponibilités et des horaires qui changent hors
 * déploiement — une réservation posée en back-office ne passe pas par elles.
 * Prérendues, elles serviraient l'état du jour de compilation, et le build
 * exigerait une base joignable.
 */
export const dynamic = 'force-dynamic'

/**
 * Coque du site public.
 *
 * Tout ce qui identifie le centre — nom, signature, logo, adresse, téléphone,
 * réseaux — vient de la table `tenants` et non du code : c'est ce qui change
 * d'un centre à l'autre (décision 1). Voir `infra/configurer-centre.mjs`.
 */
export default async function PortailLayout({ children }: { children: React.ReactNode }) {
  const [tenant, regles] = await Promise.all([currentTenant(), listOpeningHours()])
  // Les horaires affichés viennent des mêmes lignes que les créneaux libres :
  // une page qui annonce une ouverture que le calendrier refuse est un piège.
  const ouverture = formatOpeningSummary(regles)

  const adresse = [tenant.addressLine1, tenant.addressLine2].filter(Boolean).join(', ')
  const ville = [tenant.postalCode, tenant.city].filter(Boolean).join(' ')
  const telHref = tenant.phone ? `tel:${tenant.phone.replace(/\s/g, '')}` : undefined
  // Un lien vers une carte, jamais une carte encastrée : un iframe Google
  // appellerait ses serveurs depuis notre page, à l'insu du visiteur.
  const planUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    [tenant.name, adresse, ville].filter(Boolean).join(', '),
  )}`

  return (
    <div className="portail flex min-h-screen flex-col bg-background text-foreground">
      <a href="#contenu" className="sr-only z-50 rounded-md bg-primary px-5 py-3 text-white focus:not-sr-only focus:inline-flex focus:min-h-11 focus:items-center focus:fixed focus:left-4 focus:top-4">Aller au contenu</a>
      <ScrollState />
      {/* Sans JavaScript, rien ne viendra révéler les blocs : ils doivent
          s'afficher d'emblée plutôt que rester invisibles. */}
      <noscript>
        <style>{'.reveal{opacity:1;transform:none}'}</style>
      </noscript>
      {/* Bandeau de service : ce qu'on cherche avant même de lire la page. */}
      <div className="hidden border-b border-white/10 bg-primary text-white/90 lg:block">
        <div className="mx-auto flex max-w-[1200px] items-center gap-6 px-8 py-2 text-xs">
          <a
            href={planUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-6 items-center gap-1.5 transition-colors hover:text-white"
          >
            <MapPinIcon size={16} />
            {[adresse, ville].filter(Boolean).join(' — ')}
          </a>
          {ouverture && (
            <span className="flex items-center gap-1.5">
              <ClockIcon size={16} />
              {ouverture}
            </span>
          )}
          {tenant.phone && telHref && (
            <a
              href={telHref}
              className="ml-auto flex min-h-6 items-center gap-1.5 font-medium transition-colors hover:text-white"
            >
              <PhoneIcon size={16} />
              {tenant.phone}
            </a>
          )}
        </div>
      </div>

      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] items-center gap-6 px-5 py-3 sm:px-8">
          {/* Le logo garde son air autour de lui : la charte demande au moins la
              hauteur du « S » de clear space. */}
          <Link href="/" className="inline-flex min-h-11 shrink-0 items-center py-1 pr-2" aria-label={`${tenant.name} — accueil`}>
            {tenant.logoPath ? (
              <Image
                src={tenant.logoPath}
                alt={tenant.name}
                width={600}
                height={191}
                preload
                className="h-9 w-auto sm:h-10"
              />
            ) : (
              <span className="text-lg font-semibold tracking-tight text-primary">
                {tenant.name}
              </span>
            )}
          </Link>

          <SectionNav
            sections={sections}
            className="ml-auto hidden items-center gap-1 lg:flex"
            linkClassName="rounded-md px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-muted"
            activeClassName="bg-muted"
          />

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            {tenant.phone && telHref && (
              <a
                href={telHref}
                aria-label={`Appeler le ${tenant.phone}`}
                className="inline-flex size-11 items-center justify-center rounded-md border border-border text-primary transition-colors hover:bg-muted lg:hidden"
              >
                <PhoneIcon size={20} />
              </a>
            )}
            <Link
              href="/#demande"
              className="press inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Réserver
            </Link>
          </div>
        </div>

        {/* Sur petit écran la navigation passe sous le logo, en bande qui défile
            plutôt qu'en menu déroulant : trois liens ne valent pas un panneau. */}
        <SectionNav
          sections={sections}
          className="flex gap-1 overflow-x-auto border-t border-border px-5 py-2 lg:hidden"
          linkClassName="inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
          activeClassName="bg-muted text-primary"
        />
      </header>

      <main id="contenu" tabIndex={-1} className="min-w-0 flex-1 scroll-mt-36 lg:scroll-mt-24">{children}</main>

      <footer className="bg-primary text-white">
        {/* Dernier appel : posé ici plutôt qu'en fin de page, pour qu'il vaille
            sur toute page publique et qu'on n'empile pas deux blocs sombres. */}
        <div className="border-b border-white/15">
          <div className="mx-auto flex max-w-[1200px] flex-col items-start gap-6 px-5 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Une question avant de réserver&nbsp;?
              </h2>
              <p className="mt-2 max-w-xl text-white/80">
                Un besoin particulier, un événement, une domiciliation : appelez-nous, nous
                organisons le reste.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              {tenant.phone && telHref && (
                <a
                  href={telHref}
                  className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-white px-6 py-3.5 font-medium text-primary transition-colors hover:bg-white/90"
                >
                  <PhoneIcon size={20} />
                  {tenant.phone}
                </a>
              )}
              <Link
                href="/#demande"
                className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-white/40 px-6 py-3.5 font-medium transition-colors hover:bg-white/10"
              >
                Demander un créneau
                <ArrowRightIcon size={20} />
              </Link>
            </div>
          </div>
        </div>

        <div className="mx-auto grid max-w-[1200px] gap-10 px-5 py-14 sm:px-8 lg:grid-cols-4">
          <div className="lg:col-span-1">
            {/* Version blanche du logo : la charte interdit de recolorer
                l'original pour le poser sur un fond sombre. */}
            {tenant.logoLightPath ? (
              <Image
                src={tenant.logoLightPath}
                alt={tenant.name}
                width={600}
                height={191}
                className="h-10 w-auto"
              />
            ) : (
              <p className="text-xl font-semibold">{tenant.name}</p>
            )}
            {tenant.tagline && <p className="mt-4 text-sm text-white/70">{tenant.tagline}</p>}

            {tenant.socialLinks.length > 0 && (
              <ul className="mt-6 flex flex-wrap gap-2">
                {tenant.socialLinks.map((lien) => (
                  <li key={lien.url}>
                    <a
                      href={lien.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center rounded-md border border-white/25 px-4 text-sm font-medium transition-colors hover:bg-white/10"
                    >
                      {lien.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="text-sm">
            <p className="font-semibold">Le centre</p>
            <address className="mt-3 not-italic text-white/70">
              {adresse && <span className="block">{adresse}</span>}
              {ville && <span className="block">{ville}</span>}
            </address>
            <a
              href={planUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-white/90 underline-offset-4 hover:underline"
            >
              <MapPinIcon size={18} />
              Voir sur la carte
            </a>
          </div>

          <div className="text-sm">
            <p className="font-semibold">Nous joindre</p>
            <div className="mt-3 flex flex-col gap-2 text-white/70">
              {tenant.phone && telHref && (
                <a href={telHref} className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline hover:text-white">
                  {tenant.phone}
                </a>
              )}
              {tenant.email && (
                <a
                  href={`mailto:${tenant.email}`}
                  className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline hover:text-white"
                >
                  {tenant.email}
                </a>
              )}
              {tenant.websiteUrl && (
                <a
                  href={tenant.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline hover:text-white"
                >
                  {tenant.websiteUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>

          <div className="text-sm">
            <p className="font-semibold">Horaires</p>
            <p className="mt-3 text-white/70">
              {ouverture ?? 'Nous contacter pour connaître les horaires.'}
            </p>
            <p className="mt-3 text-xs text-white/50">
              Heures affichées en {tenant.timezone}.
            </p>
          </div>
        </div>

        <div className="border-t border-white/15">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-2 px-5 py-5 text-xs text-white/60 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p>
              {tenant.legalName
                ? `${tenant.name} est exploité par ${tenant.legalName}.`
                : tenant.name}
            </p>
            {/* Les mentions légales restent à écrire. */}
            <div className="flex gap-4">
              <Link href="/compte" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                Espace client
              </Link>
              <Link href="/auth/connexion" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                Accès équipe
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
