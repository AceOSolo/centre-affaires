import Link from 'next/link'

import {
  publishListingAction,
  unpublishListingAction,
} from '../../../../modules/ressources/annonces-actions.ts'
import { listAllListings } from '../../../../modules/ressources/annonces-queries.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Annonces' }

export default async function AnnoncesPage() {
  const [listings, resources] = await Promise.all([listAllListings(), listBookableResources()])

  const annoncees = new Set(listings.map((listing) => listing.resourceId))
  const sansAnnonce = resources.filter((resource) => !annoncees.has(resource.id))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Annonces</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ce que le centre loue, tel que le site public le présente. Une annonce publiée
            affiche les disponibilités réelles et le prix de la grille par défaut.
          </p>
        </div>
        {sansAnnonce.length > 0 && (
          <Link
            href="/ressources/annonces/nouvelle"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Nouvelle annonce
          </Link>
        )}
      </div>

      {listings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucune annonce. Le catalogue public est vide.
          </p>
          <Link
            href="/ressources/annonces/nouvelle"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Rédiger une annonce
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Titre</th>
                <th className="px-4 py-3 font-medium">Ressource</th>
                <th className="px-4 py-3 font-medium">Adresse</th>
                <th className="px-4 py-3 font-medium">État</th>
                <th className="px-4 py-3 font-medium sr-only">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {listings.map((listing) => {
                const publiee = listing.publishedAt !== null
                // Une ressource hors service disparaît du catalogue sans qu'on
                // ait à dépublier son annonce : le dire ici évite de chercher
                // pourquoi elle n'apparaît plus.
                const horsService = listing.resource.status !== 'active'
                return (
                  <tr key={listing.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/ressources/annonces/${listing.resourceId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {listing.headline}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="font-mono text-xs">{listing.resource.code}</span>{' '}
                      {resourceTypeLabels[listing.resource.resourceType]}
                    </td>
                    <td className="px-4 py-3">
                      {publiee ? (
                        <Link
                          href={`/annonces/${listing.slug}`}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                        >
                          /annonces/{listing.slug}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          /annonces/{listing.slug}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          publiee && !horsService
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {!publiee
                          ? 'Brouillon'
                          : horsService
                            ? 'Masquée — hors service'
                            : 'Publiée'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={publiee ? unpublishListingAction : publishListingAction}>
                        <input type="hidden" name="id" value={listing.id} />
                        <input type="hidden" name="slug" value={listing.slug} />
                        <button
                          type="submit"
                          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                          {publiee ? 'Dépublier' : 'Publier'}
                        </button>
                      </form>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {sansAnnonce.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sans annonce :{' '}
          {sansAnnonce.map((resource) => `${resource.code} ${resource.name}`).join(', ')}.
        </p>
      )}
    </div>
  )
}
