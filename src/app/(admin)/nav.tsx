'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useId, useState, useSyncExternalStore } from 'react'

import type { Permission } from '../../lib/auth/permissions.ts'
import type { InboxShelf } from './aujourdhui/journee.ts'
import { activeEntry } from './nav-actif.ts'
import {
  groupKey,
  isFoldable,
  isGroupOpen,
  OPENED_COOKIE,
  OPENED_COOKIE_MAX_AGE,
  parseOpened,
  serializeOpened,
  toggleOpened,
} from './nav-plie.ts'
import { menuGroups as groups, type MenuEntry as Entry } from './menu.ts'

/*
 * Rayons pliés (ADR 064), sauf ceux que le cookie dit ouverts (ADR 067). Les
 * deux rendus de la navigation (barre latérale, menu des écrans étroits) le
 * lisent par le même magasin : un rayon ouvert dans l'un l'est aussi dans
 * l'autre.
 */
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function readOpenedCookie(): string {
  const prefix = `${OPENED_COOKIE}=`
  const raw = document.cookie.split('; ').find((part) => part.startsWith(prefix))
  return serializeOpened(parseOpened(raw?.slice(prefix.length)))
}

function writeOpenedCookie(keys: readonly string[]) {
  const value = serializeOpened(keys)
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${OPENED_COOKIE}=${value}; path=/; max-age=${value ? OPENED_COOKIE_MAX_AGE : 0}; samesite=lax${secure}`
  for (const listener of listeners) listener()
}

const pendingLabel = (count: number) => `${count} demande${count > 1 ? 's' : ''} à traiter`

/**
 * Navigation du back-office, rangée par service vendu (ADR 053), chaque rayon
 * pliable (ADR 064). Client parce que l'entrée active dépend de l'URL
 * courante ; le reste de la coque reste rendu sur le serveur.
 */
export function Nav({
  inboxCounts = {},
  allowed,
  opened: openedOnServer = [],
}: {
  /** Demandes à traiter par rayon (`inboxCountsByShelf`, ADR 070) : leur somme est le nombre de la cloche. */
  inboxCounts?: Partial<Record<InboxShelf, number>>
  /** Droits du membre connecté (`permissionsOf`). */
  allowed: readonly Permission[]
  /** Rayons ouverts, lus dans le cookie par la coque : le premier rendu est déjà le bon. */
  opened?: readonly string[]
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // La navigation est rendue deux fois (barre latérale, menu des écrans
  // étroits) : les identifiants des titres doivent rester uniques.
  const prefix = useId()
  const serverSnapshot = serializeOpened(openedOnServer)
  const opened = parseOpened(useSyncExternalStore(subscribe, readOpenedCookie, () => serverSnapshot))
  // Le rayon de la page en cours, plié à la main sur cette page : il le reste
  // jusqu'à la page suivante, où il se rouvre.
  const [dismissed, setDismissed] = useState<{ key: string; at: string }>()
  const here = `${pathname}?${searchParams.toString()}`

  const permitted = (entry: Entry) =>
    (typeof entry.permission === 'string' ? [entry.permission] : entry.permission).some((permission) =>
      allowed.includes(permission),
    )

  // Une catégorie dont aucune entrée n'est permise disparaît avec son titre.
  // Le pliage se lit sur le groupe déclaré, avant ce filtre.
  const visibles = groups
    .map((group) => ({
      ...group,
      key: groupKey(group.label),
      foldable: isFoldable(group),
      entries: group.entries.filter(permitted),
    }))
    .filter((group) => group.entries.length > 0)

  // Chaque adresse qui allume une entrée, rapportée à cette entrée.
  const owners = new Map<string, string>()
  for (const entry of visibles.flatMap((group) => group.entries)) {
    for (const href of [entry.href, ...(entry.also ?? [])]) owners.set(href, entry.href)
  }
  const matched = activeEntry([...owners.keys()], pathname, new URLSearchParams(searchParams.toString()))
  const actif = matched ? owners.get(matched) : undefined
  const activeKey = visibles.find((group) => group.entries.some((entry) => entry.href === actif))?.key
  const dismissedKey = dismissed?.at === here ? dismissed.key : undefined

  const toggle = (key: string, open: boolean) => {
    writeOpenedCookie(toggleOpened(opened, key, open))
    if (key === activeKey) setDismissed(open ? { key, at: here } : undefined)
  }

  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-3">
      {visibles.map((group, index) => {
        const titleId = `${prefix}-${group.key}`
        const listId = `${titleId}-liste`
        const last = index === visibles.length - 1 && group.label === 'Réglages'
        const open = isGroupOpen(group, { opened, active: activeKey, dismissed: dismissedKey })
        // Plié, le rayon garde à son titre les demandes à traiter de sa ligne « Demandes ».
        const folded = group.entries.reduce((sum, entry) => sum + (entry.counter ? (inboxCounts[entry.counter] ?? 0) : 0), 0)

        // Une marge intérieure dans un cadre `-mx-1` : le contour de focus des
        // liens tient dans la zone qui masque le rayon plié, au lieu d'y être
        // rogné. Sous un titre pliable, 8 px séparent les deux cibles.
        const list = (
          <ul className={`flex flex-col gap-0.5 px-1 pb-1 ${group.foldable ? 'pt-2' : 'pt-1'}`}>
            {group.entries.map((entry) => {
              const active = entry.href === actif
              const count = entry.counter ? (inboxCounts[entry.counter] ?? 0) : 0
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
                      <span className="rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular">
                        <span aria-hidden="true">{count}</span>
                        <span className="sr-only">{pendingLabel(count)}</span>
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )

        return (
          <div
            key={group.label}
            role="group"
            aria-labelledby={titleId}
            className={last ? 'border-t border-border pt-4' : undefined}
          >
            {group.foldable ? (
              <>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => toggle(group.key, open)}
                  className="flex min-h-6 w-full items-center justify-between gap-2 rounded-sm px-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span id={titleId}>{group.label}</span>
                  <span className="flex items-center gap-2">
                    {!open && folded > 0 && (
                      <span className="rounded-full bg-primary px-1.5 font-semibold normal-case tracking-normal text-white tabular">
                        <span aria-hidden="true">{folded}</span>
                        <span className="sr-only">{pendingLabel(folded)}</span>
                      </span>
                    )}
                    {/* Lucide « chevron-down » ; tourné vers la droite, le rayon est plié. */}
                    <svg
                      width={20}
                      height={20}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                      className={`shrink-0 transition-transform duration-200 ease-out ${open ? '' : '-rotate-90'}`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                </button>
                {/* La hauteur passe de 0 à celle des entrées en 200 ms ;
                    `prefers-reduced-motion` la rend immédiate (globals.css).
                    Plié, `inert` et `invisible` sortent les liens de la
                    tabulation et des lecteurs d'écran. */}
                <div
                  id={listId}
                  inert={!open}
                  className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out ${
                    open ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
                  }`}
                >
                  <div className="-mx-1 min-h-0 overflow-hidden">{list}</div>
                </div>
              </>
            ) : (
              <>
                {/* Un groupe qui porte le nom de sa première entrée
                    (« Aujourd’hui », « Réglages ») ne se plie pas : son titre
                    reste lu par les lecteurs d'écran, sans répéter le libellé
                    à l'œil. */}
                <p id={titleId} className="sr-only">
                  {group.label}
                </p>
                <div className="-mx-1">{list}</div>
              </>
            )}
          </div>
        )
      })}
    </nav>
  )
}
