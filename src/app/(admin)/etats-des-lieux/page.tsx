import Link from 'next/link'

import { FlashNotice } from '../../../components/ui/flash-notice.tsx'
import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import {
  HISTORY_PAGE_SIZE,
  historyHref,
  historyKinds,
  historyStates,
  isFiltered,
  pageCount,
  parseHistoryFilters,
  type HistoryParams,
} from '../../../modules/etats-des-lieux/historique.ts'
import {
  inspectionKindLabels,
  inspectionStageLabels,
  inspectionStageStyles,
} from '../../../modules/etats-des-lieux/labels.ts'
import {
  listInspectionFilterOptions,
  searchInspections,
} from '../../../modules/etats-des-lieux/queries.ts'
import { fieldClass, labelClass, linkClass, primaryButton } from '../../../modules/etats-des-lieux/styles.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'
import { ProductFilter } from '../../../modules/ressources/product-filter.tsx'

export const metadata = { title: 'États des lieux' }

/**
 * Historique des états des lieux du centre (R06, ADR 039, ADR 063) : la liste
 * complète, filtrable par client, ressource, période, étape (entrée ou
 * sortie), état et produit, page par page. Un état des lieux s'ouvre depuis
 * la fiche d'une ressource, d'une réservation ou d'un contrat.
 *
 * Le formulaire de filtres part en `GET` : l'adresse garde la recherche, se
 * partage et revient avec le bouton « Précédent » du navigateur.
 */
export default async function InspectionsPage({
  searchParams,
}: {
  searchParams: Promise<HistoryParams & { fait?: string }>
}) {
  const { member } = await requirePermission('etats-des-lieux.gerer')
  const { fait, ...params } = await searchParams
  const timeZone = await currentTimeZone()
  const filters = parseHistoryFilters(params, timeZone)
  const { values, product } = filters

  const [{ rows, total, page }, options] = await Promise.all([
    // Une page au-delà de la dernière montre la dernière.
    searchInspections(filters.query, { page: filters.page, pageSize: HISTORY_PAGE_SIZE }),
    listInspectionFilterOptions(),
  ])
  const pages = pageCount(total)
  const firstShown = total === 0 ? 0 : (page - 1) * HISTORY_PAGE_SIZE + 1
  const lastShown = Math.min(page * HISTORY_PAGE_SIZE, total)
  const filtered = isFiltered(filters)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">
            États des lieux{product && ` · ${product.label}`}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            L’historique des entrées et des sorties. Un état des lieux s’ouvre depuis la fiche de la
            ressource, de la réservation ou du contrat ; une fois clos, le client le valide dans son
            espace. La fiche d’une ressource montre sa chronologie, occupation par occupation.
          </p>
        </div>
        {can(member.role, 'etats-des-lieux.modeles') && (
          <Link
            href="/etats-des-lieux/modeles"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted"
          >
            Modèles de formulaire
          </Link>
        )}
      </div>

      {fait === 'retire' && (
        <FlashNotice key={fait}>Brouillon retiré : il n’apparaît plus dans la liste.</FlashNotice>
      )}

      <ProductFilter
        active={product}
        only={['salles', 'bureaux', 'vehicules']}
        href={(key) => historyHref({ ...values, produit: key })}
      />

      <form
        method="get"
        action="/etats-des-lieux"
        aria-labelledby="filtres-titre"
        className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
      >
        <h2 id="filtres-titre" className="text-sm font-semibold tracking-tight">
          Rechercher
        </h2>
        {/* Le produit se choisit par les pastilles : le formulaire le garde. */}
        {values.produit && <input type="hidden" name="produit" value={values.produit} />}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div>
            <label htmlFor="filtre-client" className={labelClass}>
              Client
            </label>
            <select id="filtre-client" name="client" defaultValue={values.client ?? ''} className={`${fieldClass} mt-1`}>
              <option value="">Tous les clients</option>
              {options.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filtre-ressource" className={labelClass}>
              Ressource
            </label>
            <select
              id="filtre-ressource"
              name="ressource"
              defaultValue={values.ressource ?? ''}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Toutes les ressources</option>
              {options.resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name} ({resource.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filtre-du" className={labelClass}>
              Du
            </label>
            <input
              id="filtre-du"
              name="du"
              type="date"
              defaultValue={values.du ?? ''}
              aria-invalid={filters.periodError ? true : undefined}
              aria-describedby={filters.periodError ? 'filtre-periode-erreur' : undefined}
              className={`${fieldClass} mt-1 tabular`}
            />
          </div>
          <div>
            <label htmlFor="filtre-au" className={labelClass}>
              Au (inclus)
            </label>
            <input
              id="filtre-au"
              name="au"
              type="date"
              defaultValue={values.au ?? ''}
              aria-invalid={filters.periodError ? true : undefined}
              aria-describedby={filters.periodError ? 'filtre-periode-erreur' : undefined}
              className={`${fieldClass} mt-1 tabular`}
            />
          </div>
          <div>
            <label htmlFor="filtre-nature" className={labelClass}>
              Étape
            </label>
            <select id="filtre-nature" name="nature" defaultValue={values.nature ?? ''} className={`${fieldClass} mt-1`}>
              <option value="">Entrées et sorties</option>
              {historyKinds.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filtre-etat" className={labelClass}>
              État
            </label>
            <select id="filtre-etat" name="etape" defaultValue={values.etape ?? ''} className={`${fieldClass} mt-1`}>
              <option value="">Tous les états</option>
              {historyStates.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filters.periodError && (
          <p id="filtre-periode-erreur" role="alert" className="text-sm text-destructive">
            {filters.periodError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className={primaryButton}>
            Rechercher
          </button>
          {filtered && (
            <Link href="/etats-des-lieux" className={linkClass}>
              Effacer les filtres
            </Link>
          )}
        </div>
      </form>

      <section aria-labelledby="resultats-titre" className="flex flex-col gap-3">
        <h2 id="resultats-titre" className="text-sm font-semibold tracking-tight" aria-live="polite">
          {total === 0
            ? 'Aucun état des lieux'
            : `${total} état${total > 1 ? 's' : ''} des lieux${
                pages > 1 ? ` · ${firstShown} à ${lastShown}` : ''
              }`}
        </h2>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white px-6 py-10 text-center text-sm text-muted-foreground">
            {filtered ? (
              <>
                <p>Aucun état des lieux ne répond à cette recherche.</p>
                <p className="mt-2">
                  Élargissez la période ou retirez un filtre —{' '}
                  <Link href="/etats-des-lieux" className={linkClass}>
                    voir tout l’historique
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <p>Aucun état des lieux pour l’instant.</p>
                <p className="mt-2">
                  Pour en ouvrir un, allez sur la fiche d’une{' '}
                  <Link href="/ressources" className={linkClass}>
                    ressource
                  </Link>
                  , d’une réservation ou d’un{' '}
                  <Link href="/contrats" className={linkClass}>
                    contrat
                  </Link>
                  , section « États des lieux ».
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">Étape</th>
                  <th scope="col" className="px-4 py-3 font-medium">Ressource</th>
                  <th scope="col" className="px-4 py-3 font-medium">Client</th>
                  <th scope="col" className="px-4 py-3 font-medium">Au titre de</th>
                  <th scope="col" className="px-4 py-3 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-3 tabular">
                      <Link href={`/etats-des-lieux/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                        {formatDateTime(row.performedAt, timeZone)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{inspectionKindLabels[row.kind]}</td>
                    <td className="px-4 py-3">
                      <Link href={`/ressources/${row.resourceId}`} className="underline-offset-2 hover:underline">
                        {row.resourceName}
                      </Link>{' '}
                      <span className="text-muted-foreground">
                        ({row.resourceCode} · {resourceTypeLabels[row.resourceType]})
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.clientName}</td>
                    <td className="px-4 py-3">
                      {row.contractReference && (row.bookingKind === 'contract' || !row.bookingTitle) ? (
                        <span className="tabular">Contrat {row.contractReference}</span>
                      ) : row.bookingTitle ? (
                        <span>Réservation « {row.bookingTitle} »</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${inspectionStageStyles[row.stage]}`}
                      >
                        {inspectionStageLabels[row.stage]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Pages de l’historique" className="flex flex-wrap items-center gap-4 text-sm">
            {page > 1 ? (
              <Link href={historyHref(values, page - 1)} rel="prev" className={linkClass}>
                ← Page précédente
              </Link>
            ) : (
              <span className="text-muted-foreground">← Page précédente</span>
            )}
            <span className="tabular" aria-current="page">
              Page {page} sur {pages}
            </span>
            {page < pages ? (
              <Link href={historyHref(values, page + 1)} rel="next" className={linkClass}>
                Page suivante →
              </Link>
            ) : (
              <span className="text-muted-foreground">Page suivante →</span>
            )}
          </nav>
        )}
      </section>
    </div>
  )
}
