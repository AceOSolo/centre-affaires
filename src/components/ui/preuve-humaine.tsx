'use client'

import type {} from 'altcha/types/react'
import { useEffect, type CSSProperties } from 'react'

import { CHAMP_PREUVE } from '../../lib/champs-anti-robot.ts'

/** Couleurs de la charte : le vert « vérifié » du widget devient le bleu de marque. */
const charte = {
  '--altcha-color-primary': 'var(--primary)',
  '--altcha-color-primary-content': 'var(--primary-foreground)',
  '--altcha-color-success': 'var(--primary)',
  '--altcha-color-success-content': 'var(--primary-foreground)',
  '--altcha-color-error': 'var(--destructive)',
  '--altcha-color-base-content': 'var(--foreground)',
  '--altcha-border-color': 'var(--border)',
  '--altcha-border-radius': '8px',
  '--altcha-checkbox-border-radius': '4px',
  '--altcha-checkbox-outline': '2px solid var(--ring)',
  '--altcha-checkbox-size': '24px',
  '--altcha-max-width': '100%',
  '--altcha-transition-duration': '200ms',
  '--altcha-checkbox-transition-duration': '200ms',
} as CSSProperties

/**
 * Case « Je ne suis pas un robot » d'ALTCHA (`lib/preuve-humaine.ts`, ADR 047),
 * à placer dans le formulaire, à l'étape de l'envoi. Le calcul démarre dès
 * qu'elle s'affiche et se fait pendant la saisie ; la case se coche seule. Au
 * clavier et au lecteur d'écran, c'est une case à cocher ordinaire, en
 * français. Pas de pied de page ni de logo : ni lien vers un site tiers, ni
 * marque étrangère à la charte.
 *
 * Le widget n'existe que dans le navigateur : il est chargé après le rendu.
 *
 * Une réponse ne sert qu'une fois : après chaque réponse du serveur, le
 * formulaire change la `key` du composant pour qu'un calcul neuf démarre.
 */
export function PreuveHumaine() {
  useEffect(() => {
    void import('altcha/i18n/fr-fr').then(() => import('altcha'))
  }, [])

  return (
    <altcha-widget
      challenge="/api/anti-robot"
      auto="onload"
      language="fr-fr"
      name={CHAMP_PREUVE}
      type="checkbox"
      configuration={JSON.stringify({ hideFooter: true, hideLogo: true })}
      style={charte}
      suppressHydrationWarning
    />
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

export const preuveEnCours = 'Vérification anti-robot en cours : patientez quelques secondes que la case se coche, puis renvoyez.'
