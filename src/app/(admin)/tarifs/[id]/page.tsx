import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  archiveRatePlanAction,
  removeRatePlanItemAction,
} from '../../../../modules/facturation/actions.ts'
import { rateUnitLabels, rateUnitSuffixes } from '../../../../modules/facturation/labels.ts'
import { findRatePlan } from '../../../../modules/facturation/queries.ts'
import { RateItemForm } from '../../../../modules/facturation/rate-item-form.tsx'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Grille tarifaire' }

export default async function RatePlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [plan, resources] = await Promise.all([findRatePlan(id), listResources()])
  if (!plan) notFound()

  const resourceNames = new Map(resources.map((resource) => [resource.id, resource]))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/tarifs" className="text-sm text-muted-foreground hover:underline">
          ← Grilles tarifaires
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{plan.name}</h1>
          {plan.isDefault && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
              Grille par défaut
            </span>
          )}
          {plan.deletedAt && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              Archivée
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Validité : {plan.validFrom ?? 'sans début'} → {plan.validTo ?? 'sans fin'} · {plan.currency}
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Prix{' '}
          <span className="font-normal text-muted-foreground">({plan.items.length})</span>
        </h2>

        {plan.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Grille vide : aucune ressource n’a de prix dans cette grille.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">S’applique à</th>
                  <th className="px-4 py-3 font-medium">Unité</th>
                  <th className="px-4 py-3 text-right font-medium">Prix HT</th>
                  <th className="px-4 py-3 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {plan.items.map((item) => {
                  const resource = item.resourceId ? resourceNames.get(item.resourceId) : undefined
                  return (
                    <tr key={item.id}>
                      <td className="px-4 py-3">
                        {resource ? (
                          <>
                            <span className="font-medium">{resource.name}</span>{' '}
                            <span className="font-mono text-xs text-muted-foreground">
                              {resource.code}
                            </span>
                            {/* Le tarif nominatif prime sur celui du type : le
                                dire évite de chercher pourquoi le prix diffère. */}
                            <div className="text-xs text-muted-foreground">
                              Prime sur le tarif {resourceTypeLabels[item.resourceType].toLowerCase()}
                            </div>
                          </>
                        ) : (
                          <span>Toutes les ressources : {resourceTypeLabels[item.resourceType]}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {rateUnitLabels[item.unit]}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        {formatCents(item.amountCents, plan.currency)}{' '}
                        <span className="text-xs text-muted-foreground">
                          {rateUnitSuffixes[item.unit]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <form action={removeRatePlanItemAction}>
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="ratePlanId" value={plan.id} />
                          <button
                            type="submit"
                            className="text-xs text-destructive underline-offset-2 hover:underline"
                          >
                            Retirer
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
      </section>

      {!plan.deletedAt && (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
          <h2 className="text-sm font-semibold tracking-tight">Ajouter un prix</h2>
          <RateItemForm ratePlanId={plan.id} resources={resources} />
        </section>
      )}

      {!plan.deletedAt && (
        <form
          action={archiveRatePlanAction}
          className="rounded-lg border border-border bg-white px-5 py-4"
        >
          <input type="hidden" name="id" value={plan.id} />
          <p className="text-sm font-medium text-foreground">Archiver la grille</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Les contrats qui la désignent restent lisibles ; ils portent leur propre montant.
          </p>
          <button
            type="submit"
            className="mt-3 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
          >
            Archiver
          </button>
        </form>
      )}
    </div>
  )
}
