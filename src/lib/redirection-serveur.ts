import { headers } from 'next/headers'

import { clientReturnPath, withReturn } from './redirection.ts'

/**
 * Adresse de retour de la page d'où part une action serveur : le paramètre
 * `retour` de l'adresse de cette page, lu dans l'en-tête `Referer` (le site
 * l'envoie en entier entre ses pages, `next.config.ts`). Validée comme toute
 * adresse de retour (`clientReturnPath`) ; absente ou douteuse : `null`.
 *
 * Évite de faire passer le retour par un champ caché de chaque formulaire :
 * une action qui revient sur sa page (`?fait=…`) garde ainsi le lien
 * « ← … » de la page tel qu'il était.
 */
export async function pageReturnPath(): Promise<string | null> {
  const referer = (await headers()).get('referer')
  if (!referer) return null
  let value: string | null
  try {
    value = new URL(referer).searchParams.get('retour')
  } catch {
    return null
  }
  return clientReturnPath(value, '') || null
}

/** `href` avec le retour de la page d'où part l'action, s'il y en a un. */
export async function keepPageReturn(href: string): Promise<string> {
  return withReturn(href, await pageReturnPath())
}
