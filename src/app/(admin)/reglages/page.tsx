import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requireAnyPermission } from '../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { parseProduct } from '../../../modules/ressources/produits.ts'
import { EmailSettingsPanel } from '../../../modules/notifications/encart-courriels.tsx'
import { reglagesPermissions, reglagesSections } from './sections.ts'

export const metadata = { title: 'Réglages' }

/**
 * « Réglages » (ADR 048) : les écrans qui paramètrent le centre, réunis hors
 * du menu, qui ne garde que ce qui se traite au quotidien. Rangés par service
 * vendu (ADR 082) : les rayons du menu, puis « Tous les services » et « Le
 * centre ». Seuls les écrans que le rôle permet sont montrés ; chacun
 * revérifie son droit.
 *
 * `?produit=salles` (la ligne « Réglages » du rayon) ne montre que ce
 * produit ; un lien discret ramène à la page entière.
 *
 * En bas de la page entière, l'encart « Courriels » (ADR 059), pour qui
 * configure le centre.
 */
export default async function ReglagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { member } = await requireAnyPermission(reglagesPermissions)
  const product = parseProduct((await searchParams).produit)
  const showsEmail = !product && can(member.role, 'centre.configurer')
  const timeZone = showsEmail ? await currentTimeZone() : 'Europe/Paris'
  const sections = reglagesSections
    .filter((section) => !product || section.key === product.key)
    .map((section) => ({ ...section, links: section.links.filter((link) => can(member.role, link.permission)) }))
    .filter((section) => section.links.length > 0)

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {product ? `Réglages — ${product.label}` : 'Réglages'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {product
            ? `Ce qui se règle pour le seul service « ${product.label} ». Ce qui vaut pour tous les services est dans la page entière.`
            : 'Ce qui se règle une fois puis s’oublie, rangé par service : chaque produit, puis ce qui sert à tous, puis le centre.'}
        </p>
        {product && (
          <Link
            href="/reglages"
            className="mt-2 inline-flex min-h-6 items-center text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            Voir tous les réglages
          </Link>
        )}
      </div>

      {sections.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
          Rien à régler ici avec votre rôle. Les autres réglages sont dans{' '}
          <Link href="/reglages" className="underline underline-offset-2">
            la page entière
          </Link>
          .
        </p>
      )}

      {sections.map((section) => (
        <section key={section.key} aria-labelledby={`reglages-${section.key}`} className="flex flex-col gap-3">
          {/* Un seul groupe : le titre de la page dit déjà le service. */}
          <h2
            id={`reglages-${section.key}`}
            className={product ? 'sr-only' : 'text-lg font-semibold tracking-tight'}
          >
            {section.title}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex h-full flex-col gap-1 rounded-lg border border-border bg-white p-4 transition-colors duration-150 ease-out hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="font-medium text-primary">{link.label}</span>
                  <span className="text-sm text-muted-foreground">{link.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {showsEmail && <EmailSettingsPanel address={member.email} timeZone={timeZone} />}
    </div>
  )
}
