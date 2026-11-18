'use client'

import type {} from 'altcha/types/react'
import { useEffect, useRef, useState } from 'react'

import { CHAMP_PREUVE } from '../../lib/champs-anti-robot.ts'
import { CheckIcon, TriangleAlertIcon } from './icons.tsx'

/** Ce que la ligne d'état dit de la vérification. */
type Etat = 'calcul' | 'verifiee' | 'echec'

/** États du widget ALTCHA (`statechange`), ramenés à ce que la personne a besoin de savoir. */
function etatDe(state: string): Etat {
  if (state === 'verified') return 'verifiee'
  if (state === 'error') return 'echec'
  return 'calcul'
}

type WidgetAltcha = HTMLElement & { verify?: () => Promise<unknown>; reset?: () => void }

/**
 * Vérification anti-robot ALTCHA (`lib/preuve-humaine.ts`, ADR 047, ADR 074),
 * à placer dans le formulaire, à l'étape de l'envoi.
 *
 * **Discrète** (recette du 17/11) : plus de case « Je ne suis pas un robot » qui
 * se cochait toute seule et donnait l'impression d'un contrôle factice. Le
 * widget est invisible ; le calcul démarre dès l'affichage et se fait pendant
 * la saisie. Une ligne d'état, annoncée poliment aux lecteurs d'écran, dit où
 * il en est : « en cours », « réussie », ou l'échec avec « Réessayer ».
 *
 * Le widget n'existe que dans le navigateur : il est chargé après le rendu.
 * Une réponse ne sert qu'une fois : après chaque réponse du serveur, le
 * formulaire change la `key` du composant pour qu'un calcul neuf démarre.
 */
export function PreuveHumaine() {
  const ref = useRef<WidgetAltcha>(null)
  const [etat, setEtat] = useState<Etat>('calcul')

  useEffect(() => {
    void import('altcha/i18n/fr-fr').then(() => import('altcha'))
  }, [])

  useEffect(() => {
    const widget = ref.current
    if (!widget) return
    const onState = (event: Event) => setEtat(etatDe((event as CustomEvent<{ state: string }>).detail?.state ?? ''))
    // Un défi expiré (30 minutes) repart de lui-même : rien à faire pour la personne.
    const onExpired = () => {
      setEtat('calcul')
      void widget.verify?.()
    }
    widget.addEventListener('statechange', onState)
    widget.addEventListener('expired', onExpired)
    return () => {
      widget.removeEventListener('statechange', onState)
      widget.removeEventListener('expired', onExpired)
    }
  }, [])

  function reessayer() {
    setEtat('calcul')
    void ref.current?.verify?.()
  }

  return (
    <div className="min-h-11">
      <altcha-widget
        ref={ref}
        challenge="/api/anti-robot"
        auto="onload"
        display="invisible"
        language="fr-fr"
        name={CHAMP_PREUVE}
        configuration={JSON.stringify({ hideFooter: true, hideLogo: true })}
        suppressHydrationWarning
      />
      <div role="status" aria-live="polite" className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {etat === 'calcul' && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <span aria-hidden="true" className="size-4 shrink-0 rounded-full border-2 border-border border-t-primary motion-safe:animate-spin" />
            Vérification anti-robot en cours…
          </span>
        )}
        {etat === 'verifiee' && (
          <span className="flex items-center gap-2 text-primary">
            <CheckIcon size={20} className="shrink-0" />
            Vérification anti-robot réussie
          </span>
        )}
        {etat === 'echec' && (
          <>
            <span className="flex items-center gap-2 text-destructive">
              <TriangleAlertIcon size={20} className="shrink-0" />
              La vérification anti-robot n’a pas abouti (connexion interrompue ou délai dépassé).
            </span>
            <button
              type="button"
              onClick={reessayer}
              className="min-h-11 rounded-md px-3 font-medium text-primary underline underline-offset-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Réessayer
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Vrai quand le calcul est fini : sinon, la demande partirait pour rien. */
export function preuvePrete(formulaire: HTMLFormElement): boolean {
  return reponsePreuve(formulaire) !== ''
}

/** La réponse du calcul, à joindre à une requête qui ne passe pas par le formulaire. */
export function reponsePreuve(formulaire: HTMLFormElement): string {
  return String(new FormData(formulaire).get(CHAMP_PREUVE) ?? '')
}

export const preuveEnCours = 'Vérification anti-robot en cours : patientez quelques secondes qu’elle indique « réussie », puis renvoyez.'
