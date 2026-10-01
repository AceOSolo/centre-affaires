import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import {
  formatRatePlanValidity,
  ratePlanValidityLabels,
  ratePlanValidityStyles,
} from '../../../modules/facturation/grilles-affichage.ts'
import { listRatePlans } from '../../../modules/facturation/queries.ts'
import { ratePlanValidityState } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Grilles tarifaires' }

export default async function RatePlansPage() {
  const { member } = await requirePermission('tarifs.gerer')
  const [plans, timeZone] = await Promise.all([listRatePlans(), currentTimeZone()])
  // Le jour du centre, pas celui du serveur (décision 4).
  const today = todayIsoDate(timeZone)
  const defaultPlan = plans.find((plan) => plan.isDefault)
  const defaultState = defaultPlan ? ratePlanValidityState(defaultPlan, today) : undefined

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Grilles tarifaires</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prix des ressources à l’heure, à la demi-journée, à la journée, à la semaine ou au mois.
            Un contrat peut désigner sa propre grille.
            {can(member.role, 'centre.configurer') && (
              <>
                {' '}
                Les règles de calcul (unité entamée, demi-journée, prorata, TVA) se règlent dans la{' '}
                <Link href="/configuration" className="underline underline-offset-2">
                  configuration du centre
                </Link>
                .
              </>
            )}
          </p>
        </div>
        <Link
          href="/tarifs/nouvelle"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Nouvelle grille
        </Link>
      </div>

      {/* Une grille par défaut hors de ses dates ne chiffre rien : le dire ici,
          avant qu'une réservation ne parte sans prix. */}
      {defaultPlan && defaultState !== 'current' && (
        <p role="status" className="rounded-md border border-statut-conflit/40 bg-white px-4 py-3 text-sm">
          <strong className="font-medium">Grille par défaut hors de ses dates</strong> — « {defaultPlan.name} »
          est valable {formatRatePlanValidity(defaultPlan)} : aujourd’hui, les réservations sans grille
          de contrat ne sont pas chiffrées. Modifiez ses dates ou désignez une autre grille par défaut.
        </p>
      )}

      {plans.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucune grille. Sans grille par défaut, aucun prix ne peut être appliqué à une
            réservation.
          </p>
          <Link
            href="/tarifs/nouvelle"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Créer une grille
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Nom</th>
                <th className="px-4 py-3 font-medium">Validité</th>
                <th className="px-4 py-3 font-medium">État</th>
                <th className="px-4 py-3 font-medium">Devise</th>
                <th className="px-4 py-3 font-medium">Rôle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/tarifs/${plan.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {plan.name}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                    {formatRatePlanValidity(plan)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ratePlanValidityStyles[ratePlanValidityState(plan, today)]}`}
                    >
                      {ratePlanValidityLabels[ratePlanValidityState(plan, today)]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{plan.currency}</td>
                  <td className="px-4 py-3">
                    {plan.isDefault ? (
                      <span className="inline-block rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
                        Grille par défaut
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Sur contrat</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
