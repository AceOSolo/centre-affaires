import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requireAnyPermission } from '../../../lib/auth/staff.ts'
import { reglagesPermissions, reglagesSections } from './sections.ts'

export const metadata = { title: 'Réglages' }

/**
 * « Réglages » (ADR 048) : les écrans qui paramètrent le centre, réunis hors
 * du menu, qui ne garde que le parcours d'une demande. Seuls les écrans que
 * le rôle permet sont montrés ; chacun revérifie son droit.
 */
export default async function ReglagesPage() {
  const { member } = await requireAnyPermission(reglagesPermissions)
  const sections = reglagesSections
    .map((section) => ({ ...section, links: section.links.filter((link) => can(member.role, link.permission)) }))
    .filter((section) => section.links.length > 0)

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Réglages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ce qui se règle une fois puis s’oublie : catalogue et tarifs, horaires, équipe, configuration.
        </p>
      </div>

      {sections.map((section, index) => (
        <section key={section.title} aria-labelledby={`reglages-${index}`} className="flex flex-col gap-3">
          <h2 id={`reglages-${index}`} className="text-lg font-semibold tracking-tight">
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
    </div>
  )
}
