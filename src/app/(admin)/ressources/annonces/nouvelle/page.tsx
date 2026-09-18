import Link from 'next/link'

import { AnnonceForm } from '../../../../../modules/ressources/annonce-form.tsx'
import { listAllListings } from '../../../../../modules/ressources/annonces-queries.ts'
import { listBookableResources } from '../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouvelle annonce' }

export default async function NewAnnoncePage() {
  const [listings, resources] = await Promise.all([listAllListings(), listBookableResources()])
  const annoncees = new Set(listings.map((listing) => listing.resourceId))
  const sansAnnonce = resources.filter((resource) => !annoncees.has(resource.id))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/ressources/annonces"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Annonces
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle annonce</h1>
      </div>
      {sansAnnonce.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          Toutes les ressources en service ont déjà une annonce.
        </p>
      ) : (
        <AnnonceForm resources={sansAnnonce} />
      )}
    </div>
  )
}
