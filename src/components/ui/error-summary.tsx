'use client'

import { useEffect, useRef } from 'react'

/**
 * Résumé des erreurs en tête de formulaire, exigé par `CLAUDE.md` : focusable,
 * annoncé, avec un lien vers chaque champ invalide. Les erreurs en ligne
 * restent à côté des champs ; ce résumé s'y ajoute, il ne les remplace pas.
 *
 * Le focus y est porté à chaque échec : l'utilisateur au clavier ou au lecteur
 * d'écran apprend l'échec là où il est, sans chercher. Le lien mène au champ
 * par son `id`, qui doit donc être le nom du champ.
 */
export function ErrorSummary({
  errors,
  labels,
  message,
}: {
  errors?: Record<string, string>
  labels: Record<string, string>
  /** Erreur qui ne tient à aucun champ en particulier. */
  message?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const entries = Object.entries(errors ?? {})

  useEffect(() => {
    if (entries.length > 0 || message) ref.current?.focus()
    // Refocalisé à chaque nouvel échec, pas à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors, message])

  if (entries.length === 0 && !message) return null

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
    >
      {message && <p>{message}</p>}
      {entries.length > 0 && (
        <>
          <p className="font-medium">
            {entries.length > 1
              ? `Le formulaire contient ${entries.length} erreurs :`
              : 'Le formulaire contient une erreur :'}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {entries.map(([field, error]) => (
              <li key={field}>
                <a href={`#${field}`} className="underline underline-offset-2">
                  {labels[field] ?? field} : {error}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
