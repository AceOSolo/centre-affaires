'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'

/**
 * Filet du back-office (ADR 057) : une erreur imprévue d'une page ou d'une
 * action serveur ne laisse plus l'écran blanc de Next (« Application error »).
 * Le menu reste en place (la coque est au-dessus), le message dit quoi faire,
 * et la référence (`digest`) est celle qu'écrivent les journaux du serveur
 * (`docker compose logs app | grep <référence>`).
 *
 * Les refus attendus (règles de la base, demande changée entre-temps) sont
 * dits par les formulaires eux-mêmes et n'arrivent pas ici. Une page ouverte
 * avant une mise en ligne peut aussi y mener : ses actions n'existent plus sur
 * le serveur, recharger la page suffit.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // Au clavier et au lecteur d'écran, on apprend l'erreur là où l'on arrive.
    titleRef.current?.focus()
  }, [])

  return (
    <div role="alert" className="flex max-w-2xl flex-col gap-4 rounded-xl border border-border bg-white px-6 py-6">
      <h1
        ref={titleRef}
        tabIndex={-1}
        className="text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Le serveur n’a pas pu terminer cette opération
      </h1>
      <p className="text-sm">
        L’opération n’a pas abouti. Réessayez ; si la page était ouverte depuis longtemps,
        rechargez-la d’abord : une mise à jour de l’application a pu avoir lieu entre-temps.
      </p>
      <p className="text-sm text-muted-foreground">
        Si cela se reproduit, prévenez la personne qui administre l’application
        {error.digest ? (
          <>
            {' '}
            en lui donnant cette référence : <span className="font-medium text-foreground tabular">{error.digest}</span>
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Réessayer
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Recharger la page
        </button>
        <Link
          href="/aujourdhui"
          className="inline-flex items-center px-2 py-2 text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Revenir à « Aujourd’hui »
        </Link>
      </div>
    </div>
  )
}
