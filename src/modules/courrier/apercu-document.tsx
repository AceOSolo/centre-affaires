'use client'

import { useEffect, useState } from 'react'

import { pdfPageImages } from './apercu-pdf.ts'

type Preview =
  | { status: 'loading' }
  | { status: 'pages'; pages: { url: string; rotation: number }[] }
  | { status: 'image'; url: string }
  | { status: 'pdf'; url: string }
  | { status: 'error'; message: string }

const rotationClass: Record<number, string> = {
  0: '',
  90: 'rotate-90',
  180: 'rotate-180',
  270: '-rotate-90',
}

/**
 * Aperçu d'un document déposé, avant de le valider (ADR 079) : les pages
 * d'un PDF de photos une à une, une photo seule, ou le PDF lui-même.
 *
 * Le document est demandé **une fois** à la route protégée
 * `/courrier/scans/…`, qui le déchiffre et inscrit la consultation au journal
 * du pli (RGPD, ADR 020) ; l'aperçu se construit ensuite dans le navigateur, à
 * partir de cette seule lecture. Un PDF qui n'est pas fait de photos
 * s'affiche par le lecteur du navigateur, depuis cette même lecture : le site
 * refuse d'être mis en cadre (`X-Frame-Options`), pas un document local.
 */
export function DocumentPreview({
  scanId,
  contentType,
  label,
}: {
  scanId: string
  contentType: string
  /** « Contenu déposé le 17/11 à 10:42 » : nom des pages pour les lecteurs d'écran. */
  label: string
}) {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' })

  useEffect(() => {
    const urls: string[] = []
    const controller = new AbortController()
    const local = (bytes: Uint8Array, type: string) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
      urls.push(url)
      return url
    }
    fetch(`/courrier/scans/${scanId}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text())
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (contentType !== 'application/pdf') {
          setPreview({ status: 'image', url: local(bytes, contentType) })
          return
        }
        const pages = pdfPageImages(bytes)
        setPreview(
          pages
            ? {
                status: 'pages',
                pages: pages.map((page) => ({ url: local(page.jpeg, 'image/jpeg'), rotation: page.rotation })),
              }
            : { status: 'pdf', url: local(bytes, 'application/pdf') },
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setPreview({
          status: 'error',
          message: error instanceof Error && error.message ? error.message : 'Le document n’a pas pu être lu.',
        })
      })
    return () => {
      controller.abort()
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [scanId, contentType])

  const open = (
    <a
      href={`/courrier/scans/${scanId}`}
      target="_blank"
      rel="noopener"
      className="text-sm font-medium text-primary underline-offset-2 hover:underline"
    >
      Ouvrir le document dans un nouvel onglet
    </a>
  )

  return (
    // La place est réservée pendant le chargement : rien ne saute sous le pouce.
    <div className="flex min-h-48 flex-col gap-3">
      <p aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {preview.status === 'loading' && 'Chargement de l’aperçu…'}
        {preview.status === 'pages' &&
          `${preview.pages.length} page${preview.pages.length > 1 ? 's' : ''} à relire avant de valider.`}
      </p>
      {preview.status === 'error' && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Aperçu impossible : {preview.message}
        </p>
      )}
      {preview.status === 'pages' && (
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {preview.pages.map((page, index) => (
            <li key={page.url}>
              <figure className="flex flex-col gap-1">
                <div className="flex items-center justify-center overflow-hidden rounded-lg border border-border bg-muted p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- page déchiffrée dans le navigateur, sans URL publique */}
                  <img
                    src={page.url}
                    alt={`${label}, page ${index + 1} sur ${preview.pages.length}`}
                    className={`max-h-[70vh] w-auto max-w-full object-contain ${rotationClass[page.rotation] ?? ''}`}
                  />
                </div>
                <figcaption className="text-xs text-muted-foreground tabular">
                  Page {index + 1} sur {preview.pages.length}
                </figcaption>
              </figure>
            </li>
          ))}
        </ol>
      )}
      {preview.status === 'image' && (
        <div className="flex items-center justify-center overflow-hidden rounded-lg border border-border bg-muted p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- document déchiffré dans le navigateur, sans URL publique */}
          <img src={preview.url} alt={label} className="max-h-[70vh] w-auto max-w-full object-contain" />
        </div>
      )}
      {preview.status === 'pdf' && (
        <object data={preview.url} type="application/pdf" aria-label={label} className="h-[70vh] w-full rounded-lg border border-border">
          <p className="px-3 py-2 text-sm text-muted-foreground">
            Ce navigateur n’affiche pas le PDF dans la page : ouvrez-le dans un nouvel onglet.
          </p>
        </object>
      )}
      <p className="text-xs text-muted-foreground">
        {open} · chaque ouverture est inscrite au journal des consultations du pli.
      </p>
    </div>
  )
}
