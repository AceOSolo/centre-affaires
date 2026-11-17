'use client'

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { BellIcon } from '../../components/ui/icons.tsx'
import {
  CLIENT_BELL_POLL_MS,
  clientBellBadge,
  clientBellPhrase,
  type ClientBellFeed,
  type ClientBellItem,
} from './cloche-client.ts'
import { markAllClientNotificationsReadAction, markClientNotificationReadAction } from './cloche-client-actions.ts'

/**
 * Cloche de l'espace client (ADR 077), en tête de l'espace : le nombre de
 * nouveautés non lues — courrier reçu, numérisation prête, réponse à une
 * demande, message du centre — et le lien vers chacune. Une nouveauté ouverte
 * depuis la cloche est marquée lue.
 *
 * Même mécanique que la cloche de l'équipe (ADR 059) : une seule
 * interrogation de `/api/compte/notifications`, toutes les minutes quand
 * l'onglet est visible, à chaque navigation et à l'ouverture du panneau. La
 * même lecture tient la pastille de l'onglet « Courrier » (`useUnreadMail`),
 * que la coque de l'espace, conservée d'une page à l'autre, ne recalcule
 * pas. Pas de websocket, pas de dépendance.
 */

type Snapshot = {
  count: number
  unreadMail: number
  /** `null` tant que la liste n'a pas été lue. */
  items: ClientBellItem[] | null
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
  // Marquées lues à l'écran, pas encore confirmées par le serveur : une
  // lecture arrivée entre-temps ne les rallume pas.
  const markedHere = new Set<string>()

  const emit = (next: Snapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const current = (): Snapshot => snapshot ?? { count: 0, unreadMail: 0, items: null, failed: false }

  /** Applique les lectures faites ici à une liste reçue du serveur. */
  const withLocalReads = (feed: ClientBellFeed): Snapshot => {
    let count = feed.count
    const items = feed.items.map((item) => {
      if (item.read || !markedHere.has(item.id)) return item
      count -= 1
      return { ...item, read: true }
    })
    return { count: Math.max(0, count), unreadMail: feed.unreadMail, items, failed: false }
  }

  async function load(): Promise<void> {
    if (stopped) return
    try {
      const response = await fetch('/api/compte/notifications', { cache: 'no-store' })
      if (response.status === 401 || response.status === 403) {
        stopped = true
        stop()
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      emit(withLocalReads((await response.json()) as ClientBellFeed))
    } catch {
      emit({ ...current(), failed: true })
    }
  }

  function refresh(): Promise<void> {
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
      if (document.visibilityState === 'visible') void refresh()
    }, CLIENT_BELL_POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', onVisible)
  }

  /** Une nouveauté ouverte : lue à l'écran tout de suite, puis en base. */
  function markRead(id: string) {
    const state = current()
    const item = state.items?.find((candidate) => candidate.id === id)
    if (!item || item.read) return
    markedHere.add(id)
    emit({
      ...state,
      count: Math.max(0, state.count - 1),
      items: state.items?.map((candidate) => (candidate.id === id ? { ...candidate, read: true } : candidate)) ?? null,
    })
    void markClientNotificationReadAction(id)
      .catch(() => undefined)
      .finally(() => {
        markedHere.delete(id)
      })
  }

  async function markAll(): Promise<void> {
    const state = current()
    emit({ ...state, count: 0, items: state.items?.map((item) => ({ ...item, read: true })) ?? null })
    try {
      await markAllClientNotificationsReadAction()
    } finally {
      await refresh()
    }
  }

  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        // La coque de l'espace vient d'apparaître : le compte est vérifié par
        // le serveur, la cloche peut de nouveau interroger.
        stopped = false
        start()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop()
          // Sortie de l'espace (déconnexion) : rien du compte précédent ne
          // doit reparaître si une autre personne se connecte dans l'onglet.
          snapshot = null
          markedHere.clear()
        }
      }
    },
    refresh,
    markRead,
    markAll,
  }
})()

/** Premier affichage : les nombres comptés par la coque, avant toute interrogation. */
export type ClientBellInitial = { count: number; unreadMail: number }

function useClientBell(initial: ClientBellInitial): Snapshot {
  const fallback = useMemo<Snapshot>(
    () => ({ count: initial.count, unreadMail: initial.unreadMail, items: null, failed: false }),
    [initial.count, initial.unreadMail],
  )
  return useSyncExternalStore(
    store.subscribe,
    () => store.get() ?? fallback,
    () => fallback,
  )
}

/**
 * Plis non lus, tenus à jour avec la cloche : la pastille de l'onglet
 * « Courrier » (`compte-nav.tsx`).
 */
export function useUnreadMail(initial: ClientBellInitial): number {
  return useClientBell(initial).unreadMail
}

export function ClientNotificationBell({ initial }: { initial: ClientBellInitial }) {
  const snapshot = useClientBell(initial)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // À chaque navigation, la cloche et la pastille du courrier se remettent à
  // jour : un pli lu sur sa fiche ne compte plus au retour.
  useEffect(() => {
    void store.refresh()
  }, [pathname])

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
  const badge = clientBellBadge(count)

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0"
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
        aria-label={`Notifications, ${clientBellPhrase(count)}`}
        onClick={() => {
          if (!open) void store.refresh()
          setOpen((value) => !value)
        }}
        className="relative inline-flex size-11 items-center justify-center rounded-md border border-border bg-white text-primary transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <BellIcon size={20} />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-primary px-1 text-center text-xs font-semibold leading-5 text-primary-foreground tabular"
          >
            {badge}
          </span>
        )}
      </button>
      {/* Annonce polie du compteur : la région existe avant que son texte change. */}
      <span className="sr-only" aria-live="polite">
        {`Notifications : ${clientBellPhrase(count)}`}
      </span>

      <div
        id={panelId}
        hidden={!open}
        role="region"
        aria-labelledby={headingId}
        className={`absolute right-0 top-full z-30 mt-2 w-[calc(100vw-2.5rem)] max-w-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-white shadow-sm ${
          open ? 'flex' : ''
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
            Nouveautés{count > 0 && <span className="tabular"> ({count} non lue{count > 1 ? 's' : ''})</span>}
          </h2>
          {count > 0 && (
            <button
              type="button"
              onClick={() => void store.markAll()}
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Tout marquer comme lu
            </button>
          )}
        </div>

        <div className="max-h-[min(28rem,calc(100vh-12rem))] overflow-y-auto">
          {items === null ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" aria-live="polite">
              {failed ? 'Les nouveautés n’ont pas pu être chargées.' : 'Chargement des nouveautés…'}
            </p>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              <p>Rien de nouveau pour l’instant.</p>
              <p className="mt-1">
                Le courrier reçu, les réponses à vos demandes et les messages du centre s’afficheront ici.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={() => {
                      store.markRead(item.id)
                      setOpen(false)
                    }}
                    className={`block min-h-11 px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
                      item.read ? '' : 'bg-accent/5'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`text-sm text-foreground ${item.read ? 'font-medium' : 'font-semibold'}`}>
                        {item.label}
                      </span>
                      {/* Jamais la couleur seule : l'état se lit aussi en toutes lettres. */}
                      {!item.read && (
                        <span className="rounded-full bg-primary px-1.5 text-xs font-medium leading-5 text-primary-foreground">
                          Non lue
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">{item.summary}</span>
                    {item.who && <span className="block text-sm text-foreground">{item.who}</span>}
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

        <div className="border-t border-border px-4 py-1">
          <Link
            href="/compte/preferences"
            onClick={() => setOpen(false)}
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Choisir les courriels que je reçois
          </Link>
        </div>
      </div>
    </div>
  )
}
