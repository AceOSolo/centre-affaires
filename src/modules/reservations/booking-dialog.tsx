'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { ArrowRightIcon, BuildingIcon, CarIcon, MapPinIcon, XIcon } from '../../components/ui/icons.tsx'
import type { ProposalProduct } from '../facturation/schema-devis.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { focusClass, showStep } from './etapes-demande.tsx'
import { PublicBookingForm, type PublicBookingResource, type SlotProduct } from './public-booking-form.tsx'
import { PublicDomiciliationForm } from './public-domiciliation-form.tsx'
import type { RequestPolicy } from './request-policy.ts'

/**
 * Réservation en fenêtre, depuis n'importe quel bouton de la page d'accueil.
 *
 * Les boutons et le dialogue ne partagent pas d'état React : la page est rendue
 * sur le serveur, ses boutons sont éparpillés dans des sections qui s'ignorent.
 * Un bouton émet un évènement, le dialogue l'écoute et signale qu'il l'a pris
 * en charge — sur une page sans dialogue, le lien suit son `href` normalement.
 */
const OPEN_EVENT = 'reservation:ouvrir'

/**
 * Ancres qui ouvrent la réservation à l'arrivée sur la page. `#demande` était
 * celle de l'ancien formulaire en bas de page : les liens déjà partagés
 * continuent de fonctionner.
 */
const OPEN_HASHES = new Set(['#reserver', '#demande'])

type Target = { product?: ProposalProduct; resourceId?: string; type?: ResourceType }
type OpenDetail = Target & { handled: boolean }

function requestBooking(target: Target): boolean {
  const detail: OpenDetail = { ...target, handled: false }
  window.dispatchEvent(new CustomEvent<OpenDetail>(OPEN_EVENT, { detail }))
  return detail.handled
}

/** Bouton de la page d'accueil qui ouvre la demande d'un produit, d'une famille ou d'un espace. */
export function ReserveButton({ product, resourceId, type, className, children, label }: Target & {
  className?: string
  children: ReactNode
  /** Nom accessible, quand le libellé visible se répète d'une carte à l'autre. */
  label?: string
}) {
  return (
    <button type="button" aria-haspopup="dialog" aria-label={label} onClick={() => requestBooking({ product, resourceId, type })} className={className}>
      {children}
    </button>
  )
}

/**
 * Lien « Réserver » de la coque publique : ouvre le dialogue sur la page
 * d'accueil, y mène depuis les autres pages.
 */
export function ReserveLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Link href="/#reserver" className={className} onClick={(event) => { if (requestBooking({})) event.preventDefault() }}>
      {children}
    </Link>
  )
}

const productIcons = { espace: BuildingIcon, vehicule: CarIcon, domiciliation: MapPinIcon } as const

/**
 * Dialogue natif (`showModal`), comme `ConfirmDialog` : le navigateur rend la
 * page inerte, retient la tabulation et ferme sur Échap. Le focus revient au
 * bouton d'origine à la fermeture. Feuille montant du bas sur téléphone,
 * fenêtre centrée au-delà.
 */
export function BookingDialog({ products, resources, initial, timeZone, currency, policy, minDate, maxDate }: {
  /** Produits proposés, avec leurs mots (`questionnaires`). */
  products: { product: ProposalProduct; label: string; description: string }[]
  /** Ressources réservables sur créneau, par produit. */
  resources: Record<SlotProduct, PublicBookingResource[]>
  /** Produit, espace, date et horaires lus dans l'adresse (`/?espace=…&date=…#reserver`). */
  initial: { product?: ProposalProduct; resourceId?: string; date: string; startTime?: string; endTime?: string }
  timeZone: string
  currency: string
  policy: RequestPolicy
  minDate: string
  maxDate: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const sent = useRef(false)
  // Rien n'est rendu avant la première ouverture : le formulaire charge ses
  // disponibilités dès qu'il a un espace, inutile de le faire à chaque visite.
  const [target, setTarget] = useState<Target & { fromUrl?: boolean; picked?: boolean; session: number }>()
  const titleId = useId()
  const offered = products.map((item) => item.product)
  // Un espace désigné dit son produit ; un seul produit proposé n'a pas à être choisi.
  const product = target?.product ?? productOf(target?.resourceId, resources) ?? (offered.length === 1 ? offered[0] : undefined)
  const choosing = Boolean(target && !product)
  const choiceHeadingRef = useRef<HTMLHeadingElement>(null)

  const close = useCallback(() => dialogRef.current?.close(), [])
  const markSent = useCallback(() => { sent.current = true }, [])

  // « Changer » disparaît sous le doigt qui l'actionne : le focus va au titre
  // du choix, annoncé par le lecteur d'écran, plutôt que retomber sur la page.
  // Chaque formulaire fait de même avec le sien à l'ouverture.
  useEffect(() => { if (choosing) showStep(choiceHeadingRef) }, [choosing])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    function open(next: Target & { fromUrl?: boolean }) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Une demande envoyée ne se rouvre pas sur son écran de confirmation.
      setTarget((previous) => ({ ...next, session: (previous?.session ?? 0) + (sent.current ? 1 : 0) }))
      sent.current = false
      if (!dialog?.open) dialog?.showModal()
    }
    function onRequest(event: Event) {
      const detail = (event as CustomEvent<OpenDetail>).detail
      detail.handled = true
      open({ product: detail.product, resourceId: detail.resourceId, type: detail.type })
    }
    function onClose() {
      if (OPEN_HASHES.has(window.location.hash)) {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
      }
      returnFocus.current?.focus()
    }

    window.addEventListener(OPEN_EVENT, onRequest)
    dialog.addEventListener('close', onClose)
    // Arrivée par un lien qui demande la réservation.
    const frame = OPEN_HASHES.has(window.location.hash)
      ? requestAnimationFrame(() => open({ product: initial.product, resourceId: initial.resourceId, fromUrl: true }))
      : undefined
    return () => {
      window.removeEventListener(OPEN_EVENT, onRequest)
      dialog.removeEventListener('close', onClose)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [initial.product, initial.resourceId])

  const formKey = `${product ?? ''}/${target?.type ?? ''}/${target?.resourceId ?? ''}/${target?.session ?? 0}`

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // Un clic sur le voile ferme : le dialogue n'a pas de marge intérieure,
      // seul le fond peut être la cible directe.
      onClick={(event) => { if (event.target === event.currentTarget) close() }}
      className="booking-dialog mb-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-xl bg-background p-0 text-foreground shadow-lg backdrop:bg-foreground/50 open:flex open:flex-col sm:m-auto sm:max-h-[min(880px,90dvh)] sm:max-w-3xl sm:rounded-xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-2 sm:px-8">
        <h2 id={titleId} className="text-base font-semibold text-primary">
          {product ? (products.find((item) => item.product === product)?.label ?? 'Réserver') : 'Réserver'}
        </h2>
        <div className="flex items-center gap-2">
          {/* Produit choisi dans la fenêtre même : on peut revenir sur ce choix. */}
          {target?.picked && (
            <button type="button" onClick={() => setTarget((previous) => previous && { ...previous, product: undefined, picked: false })} className={`min-h-11 rounded-md px-3 text-sm font-medium text-primary hover:bg-muted ${focusClass}`}>Changer</button>
          )}
          <button type="button" onClick={close} aria-label="Fermer" className={`-mr-2 inline-flex size-11 items-center justify-center rounded-full text-primary transition-colors hover:bg-muted ${focusClass}`}>
            <XIcon size={20} />
          </button>
        </div>
      </div>
      <div data-defilement className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {choosing && (
          <div className="px-5 pb-8 pt-6 sm:px-8">
            <h3 ref={choiceHeadingRef} tabIndex={-1} className={`rounded-sm text-2xl font-semibold tracking-tight text-primary ${focusClass}`}>Que souhaitez-vous réserver&nbsp;?</h3>
            <ul className="mt-6 grid gap-3">
              {products.map((item) => {
                const Icon = productIcons[item.product]
                return (
                  <li key={item.product}>
                    <button type="button" onClick={() => setTarget((previous) => previous && { ...previous, product: item.product, picked: true })} className={`flex min-h-11 w-full items-center gap-4 rounded-lg border-2 border-border p-4 text-left transition-colors hover:border-primary ${focusClass}`}>
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-primary"><Icon size={20} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-primary">{item.label}</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">{item.description}</span>
                      </span>
                      <ArrowRightIcon size={20} className="shrink-0 text-primary" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {target && product === 'domiciliation' && <PublicDomiciliationForm key={formKey} onClose={close} onSent={markSent} />}
        {target && (product === 'espace' || product === 'vehicule') && (
          <PublicBookingForm
            key={formKey}
            product={product}
            resources={resources[product]}
            currency={currency}
            timeZone={timeZone}
            policy={policy}
            defaultResourceId={target.resourceId}
            defaultType={target.type}
            defaultDate={target.fromUrl ? initial.date : minDate}
            minDate={minDate}
            maxDate={maxDate}
            defaultStartTime={target.fromUrl ? initial.startTime : undefined}
            defaultEndTime={target.fromUrl ? initial.endTime : undefined}
            onClose={close}
            onSent={markSent}
          />
        )}
      </div>
    </dialog>
  )
}

function productOf(resourceId: string | undefined, resources: Record<SlotProduct, PublicBookingResource[]>): SlotProduct | undefined {
  if (!resourceId) return undefined
  return (Object.keys(resources) as SlotProduct[]).find((product) => resources[product].some((item) => item.id === resourceId))
}
