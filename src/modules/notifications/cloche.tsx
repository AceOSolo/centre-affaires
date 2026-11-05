'use client'

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { BellIcon } from '../../components/ui/icons.tsx'
import { STAFF_NOTIFICATION_PANEL_LIMIT, STAFF_NOTIFICATION_POLL_MS, inboxBadge, inboxPhrase, type InboxFeed, type InboxItem } from './cloche.ts'

/**
 * Cloche de l'équipe (ADR 059), dans l'en-tête du back-office : barre
 * latérale sur grand écran, bandeau du haut sur écran étroit. Elle montre ce
 * qui reste à traiter, comme « Demandes », qui n'est plus au menu (ADR 070) :
 * une demande en sort dès qu'elle est traitée, par n'importe quel membre.
 *
 * Les deux cloches de la coque — une seule est affichée à la fois —
 * partagent un même état et une seule interrogation : toutes les minutes,
 * à chaque navigation et à l'ouverture du panneau (`/api/equipe/notifications`).
 * Pas de websocket, pas de dépendance.
 */

type Snapshot = {
  count: number
  /** `null` tant que la liste n'a pas été lue. */
  items: InboxItem[] | null
  /** La dernière lecture a échoué : la liste affichée est la précédente. */
  failed: boolean
}

const store = (() => {
  let snapshot: Snapshot | null = null
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | null = null
  // Session terminée : la cloche se tait jusqu'au prochain chargement.
  let stopped = false

  const emit = (next: Snapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const current = (): Snapshot => snapshot ?? { count: 0, items: null, failed: false }

  async function load(): Promise<void> {
    if (stopped) return
    try {
      const response = await fetch('/api/equipe/notifications', { cache: 'no-store' })
      if (response.status === 401 || response.status === 403) {
        stopped = true
        stop()
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const feed = (await response.json()) as InboxFeed
      emit({ count: feed.count, items: feed.items, failed: false })
    } catch {
      emit({ ...current(), failed: true })
    }
  }

  function refresh(): Promise<void> {
    // Les deux cloches demandent ensemble à chaque navigation : une seule requête.
    pending ??= load().finally(() => {
      pending = null
    })
    return pending
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh()
  }

  function start() {
    timer = setInterval(() => {
      // Onglet en arrière-plan : rien ne sert d'interroger.
      if (document.visibilityState === 'visible') void refresh()
    }, STAFF_NOTIFICATION_POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', onVisible)
  }

  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && !stopped) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh,
  }
})()

export function StaffNotificationBell({
  initialCount,
  placement,
}: {
  /** Compté avec la page (`inboxCount`) : la pastille est juste dès le premier affichage. */
  initialCount: number
  /** `sidebar` : panneau sous la cloche ; `header` : panneau sur toute la largeur du bandeau. */
  placement: 'sidebar' | 'header'
}) {
  const fallback = useMemo<Snapshot>(() => ({ count: initialCount, items: null, failed: false }), [initialCount])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.get() ?? fallback,
    () => fallback,
  )
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // À chaque navigation, la cloche se remet à jour ; et quand la coque, rendue
  // de nouveau après une action (demande validée, prise en charge…), compte
  // autre chose : on reste alors sur la même page.
  useEffect(() => {
    void store.refresh()
  }, [pathname, initialCount])

  // Un clic hors du panneau le referme.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const { count, items, failed } = snapshot
  const badge = inboxBadge(count)

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  return (
    <div
      ref={wrapperRef}
      className={placement === 'sidebar' ? 'relative' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          close(true)
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Demandes, ${inboxPhrase(count)}`}
        onClick={() => {
          if (!open) void store.refresh()
          setOpen((value) => !value)
        }}
        className={`relative inline-flex items-center justify-center rounded-md text-primary transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
          placement === 'header' ? 'size-11 border border-border' : 'size-9'
        }`}
      >
        <BellIcon size={20} />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 min-w-5 rounded-full bg-primary px-1 text-center text-xs font-semibold leading-5 text-primary-foreground tabular"
          >
            {badge}
          </span>
        )}
      </button>
      {/* Annonce polie du compteur : la région existe avant que son texte change. */}
      <span className="sr-only" aria-live="polite">
        {`Demandes : ${inboxPhrase(count)}`}
      </span>

      <div
        id={panelId}
        hidden={!open}
        role="region"
        aria-labelledby={headingId}
        // Un lien suivi referme le panneau.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false)
        }}
        className={`z-30 flex-col overflow-hidden border border-border bg-white shadow-sm ${
          placement === 'sidebar'
            ? 'absolute left-0 top-full mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg'
            : 'absolute inset-x-0 top-full rounded-b-lg border-t-0'
        } ${open ? 'flex' : ''}`}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
            Demandes à traiter{count > 0 && <span className="tabular"> ({count})</span>}
          </h2>
        </div>

        <div className="max-h-[min(28rem,calc(100vh-10rem))] overflow-y-auto">
          {items === null ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" aria-live="polite">
              {failed ? 'Les demandes n’ont pas pu être chargées.' : 'Chargement des demandes…'}
            </p>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              <p>Rien à traiter pour l’instant.</p>
              <p className="mt-1">
                Les demandes des clients — réservations, devis, courrier, offres — s’afficheront ici dès
                leur arrivée, jusqu’à ce que quelqu’un les traite.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link
                    href={item.href}
                    className="block px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-foreground">{item.label}</span>
                      {item.state && (
                        <span className="rounded-full border border-border px-1.5 text-xs font-medium leading-5 text-primary">
                          {item.state}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-foreground">{item.who}</span>
                    <span className="block text-sm text-muted-foreground">{item.summary}</span>
                    <time dateTime={item.createdAt} className="mt-0.5 block text-xs text-muted-foreground">
                      {item.when}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {failed && items !== null && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Dernière mise à jour impossible : la liste peut dater un peu.
            </p>
          )}
        </div>

        <div className="border-t border-border px-4 py-2">
          <Link
            href="/demandes"
            className="inline-flex min-h-8 items-center rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Voir toutes les demandes
            {count > STAFF_NOTIFICATION_PANEL_LIMIT && <span className="tabular">&nbsp;({count})</span>}
          </Link>
        </div>
      </div>
    </div>
  )
}
