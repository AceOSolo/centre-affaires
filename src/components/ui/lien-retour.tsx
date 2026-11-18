'use client'

import { useEffect, useSyncExternalStore } from 'react'

import Link from 'next/link'

import { pasEnArriere, retourDe } from '../../lib/retour.ts'
import { ArrowLeftIcon } from './icons.tsx'

/**
 * Lien de retour commun (recette du 17/11) : ramène **là où l'on était**.
 *
 * 1. `?retour=` dans l'adresse, posé par la liste qui a ouvert la fiche
 *    (filtres compris) et validé contre les redirections externes ;
 * 2. sinon la page d'avant dans l'historique de l'onglet, si elle est du
 *    site — ni la fiche rechargée après « Enregistrer », ni un formulaire
 *    (`pasEnArriere`) : on y recule, comme le bouton du navigateur ;
 * 3. sinon `href`, l'adresse par défaut.
 *
 * Le serveur rend l'adresse par défaut ; le navigateur la remplace après
 * chargement. Le libellé dit la page par défaut (« ← Ressources ») et devient
 * « ← Retour » quand le lien mène ailleurs. Un vrai lien : il s'ouvre aussi
 * dans un nouvel onglet, au clavier comme à la souris.
 *
 * L'historique de l'onglet est suivi par `SuiviHistorique`, monté une fois
 * dans la mise en page : chaque entrée reçoit sa position, qu'on retrouve en
 * reculant ou en avançant.
 */

const CLE = '__retourPosition'

let installe = false
let entrees: (string | undefined)[] = []
let position = 0
let version = 0
const abonnes = new Set<() => void>()

const ici = () => window.location.pathname + window.location.search

const marque = (data: unknown, at: number) =>
  data !== null && typeof data === 'object' ? { ...data, [CLE]: at } : data

let dernier = ''

/** Prévient les liens après coup : Next écrit l'historique pendant ses effets. */
function noter() {
  const adresse = ici()
  entrees[position] = adresse
  if (dernier === `${position} ${adresse}`) return
  dernier = `${position} ${adresse}`
  queueMicrotask(() => {
    version++
    for (const abonne of abonnes) abonne()
  })
}

function installer() {
  if (installe || typeof window === 'undefined') return
  installe = true
  const stored = (window.history.state as Record<string, unknown> | null)?.[CLE]
  position = typeof stored === 'number' ? stored : 0
  entrees = []
  const push = window.history.pushState
  const replace = window.history.replaceState
  window.history.pushState = function (data, unused, url) {
    position += 1
    entrees.length = position
    push.call(this, marque(data, position), unused, url)
    noter()
  }
  window.history.replaceState = function (data, unused, url) {
    replace.call(this, marque(data, position), unused, url)
    noter()
  }
  window.addEventListener('popstate', (event) => {
    const at = (event.state as Record<string, unknown> | null)?.[CLE]
    position = typeof at === 'number' ? at : position
    noter()
  })
  replace.call(window.history, marque(window.history.state ?? {}, position), '')
  noter()
}

function abonner(abonne: () => void) {
  installer()
  abonnes.add(abonne)
  return () => {
    abonnes.delete(abonne)
  }
}

/** Suit l'historique de l'onglet dès le chargement ; ne rend rien. */
export function SuiviHistorique() {
  useEffect(installer, [])
  return null
}

const focusClass =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export function LienRetour({
  href,
  label,
  icone = false,
  className = 'text-sm text-muted-foreground hover:underline',
}: {
  /** Adresse par défaut, quand on ne sait pas d'où l'on vient. */
  href: string
  /** Nom de la page par défaut : « Ressources », « Contrat C-12 »… */
  label: React.ReactNode
  /** Flèche en icône plutôt qu'en caractère. */
  icone?: boolean
  className?: string
}) {
  const client = useSyncExternalStore(abonner, () => version, () => -1) >= 0

  let cible = href
  let pas: number | undefined
  if (client) {
    const retour = retourDe(window.location.search, window.location.pathname)
    pas = retour ? undefined : pasEnArriere(entrees, position, window.location.pathname)
    cible = retour ?? (pas ? (entrees[position - pas] ?? href) : href)
  }
  const texte = cible === href ? label : 'Retour'

  return (
    <Link
      href={cible}
      className={`${className} ${focusClass}`}
      onClick={(event) => {
        if (!pas || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        // Reculer plutôt qu'avancer vers la même page : l'historique ne
        // grossit pas, et la liste retrouve sa position de défilement.
        event.preventDefault()
        window.history.go(-pas)
      }}
    >
      {icone ? (
        <>
          <ArrowLeftIcon size={20} />
          {texte}
        </>
      ) : (
        <>← {texte}</>
      )}
    </Link>
  )
}
