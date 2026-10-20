'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useId } from 'react'

import type { Permission } from '../../lib/auth/permissions.ts'
import { activeEntry } from './nav-actif.ts'
import { menuGroups as groups, type MenuEntry as Entry } from './menu.ts'

/**
 * Navigation du back-office, rangée par étape du parcours (ADR 048). Client parce que l'entrée
 * active dépend de l'URL courante ; le reste de la coque reste rendu sur le
 * serveur.
 */
export function Nav({
  inboxCount = 0,
  mailRequestCount = 0,
  allowed,
}: {
  /** Demandes à traiter : réservations en attente et devis à compléter. */
  inboxCount?: number
  mailRequestCount?: number
  /** Droits du membre connecté (`permissionsOf`). */
  allowed: readonly Permission[]
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // La navigation est rendue deux fois (barre latérale, menu des écrans
  // étroits) : les identifiants des titres doivent rester uniques.
  const prefix = useId()

  const permitted = (entry: Entry) =>
    (typeof entry.permission === 'string' ? [entry.permission] : entry.permission).some((permission) =>
      allowed.includes(permission),
    )

  // Une catégorie dont aucune entrée n'est permise disparaît avec son titre.
  const visibles = groups
    .map((group) => ({ ...group, entries: group.entries.filter(permitted) }))
    .filter((group) => group.entries.length > 0)

  // Chaque adresse qui allume une entrée, rapportée à cette entrée.
  const owners = new Map<string, string>()
  for (const entry of visibles.flatMap((group) => group.entries)) {
    for (const href of [entry.href, ...(entry.also ?? [])]) owners.set(href, entry.href)
  }
  const matched = activeEntry([...owners.keys()], pathname, new URLSearchParams(searchParams.toString()))
  const actif = matched ? owners.get(matched) : undefined

  const counts = { inbox: inboxCount, mail: mailRequestCount }

  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-5">
      {visibles.map((group, index) => {
        const titleId = `${prefix}-${group.label.replace(/\s+/g, '-')}`
        const last = index === visibles.length - 1 && group.label === 'Réglages'
        return (
          <div
            key={group.label}
            role="group"
            aria-labelledby={titleId}
            className={last ? 'border-t border-border pt-4' : undefined}
          >
            <p
              id={titleId}
              // Le dernier groupe n'a qu'une entrée du même nom : son titre
              // reste lu par les lecteurs d'écran, sans répéter le libellé à l'œil.
              className={
                last ? 'sr-only' : 'px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground'
              }
            >
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.entries.map((entry) => {
                const active = entry.href === actif
                const count = entry.counter ? counts[entry.counter] : 0
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      aria-current={active ? 'page' : undefined}
                      // L'entrée active ne se lit pas qu'à la couleur : graisse
                      // et filet à gauche la distinguent aussi.
                      className={`flex items-center justify-between gap-2 rounded-sm border-l-[3px] px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                        active
                          ? 'border-primary bg-accent/10 font-semibold text-primary'
                          : 'border-transparent font-medium text-foreground/80 hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span>{entry.label}</span>
                      {count > 0 && (
                        <span
                          className="rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular"
                          aria-label={
                            entry.counter === 'inbox'
                              ? `${count} demande${count > 1 ? 's' : ''} à traiter`
                              : `${count} demande${count > 1 ? 's' : ''} de courrier à traiter`
                          }
                        >
                          {count}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
