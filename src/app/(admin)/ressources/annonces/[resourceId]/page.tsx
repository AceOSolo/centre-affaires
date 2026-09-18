import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AnnonceForm } from '../../../../../modules/ressources/annonce-form.tsx'
import { findListingForResource } from '../../../../../modules/ressources/annonces-queries.ts'
import { findResource } from '../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Annonce' }

export default async function EditAnnoncePage({
  params,
}: {
  params: Promise<{ resourceId: string }>
}) {
  const { resourceId } = await params
  const [resource, listing] = await Promise.all([
    findResource(resourceId),
    findListingForResource(resourceId),
  ])
  if (!resource) notFound()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/ressources/annonces"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Annonces
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {listing ? 'Modifier l’annonce' : 'Rédiger une annonce'}
        </h1>
        {listing?.publishedAt && (
          <p className="mt-1 text-sm text-muted-foreground">
            Publiée — les modifications sont visibles immédiatement sur{' '}
            <Link href={`/annonces/${listing.slug}`} className="underline underline-offset-2">
              /annonces/{listing.slug}
            </Link>
          </p>
        )}
      </div>
      <AnnonceForm resource={resource} listing={listing} resources={[]} />
    </div>
  )
}
