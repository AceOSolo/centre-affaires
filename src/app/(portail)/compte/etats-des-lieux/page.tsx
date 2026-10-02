import Link from 'next/link'

import { CheckIcon, ClockIcon, FileTextIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import {
  inspectionKindTitles,
  inspectionStageClientLabels,
} from '../../../../modules/etats-des-lieux/labels.ts'
import { countToSign, listInspectionsForAccounts } from '../../../../modules/etats-des-lieux/queries.ts'

export const metadata = { title: 'Mes états des lieux' }

/**
 * États des lieux des entreprises du compte (R06, R24) : ceux que le centre a
 * clos, à consulter et à valider. Mobile d'abord : une carte par état des
 * lieux, l'action en pleine largeur, 44 px de haut.
 */
export default async function ClientInspectionsPage() {
  const { accounts } = await requireClientAccount()
  const [rows, timeZone] = await Promise.all([
    listInspectionsForAccounts(accounts),
    currentTimeZone(),
  ])
  const several = accounts.length > 1
  const toSign = countToSign(rows)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Mes états des lieux
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Les états des lieux d’entrée et de sortie des bureaux, salles, véhicules et boîtes aux lettres
          que vous occupez. Relisez-les et validez-les ; vous pouvez y joindre vos réserves.
        </p>
        {toSign > 0 && (
          <p className="mt-2 text-sm font-medium text-primary">
            {toSign} état{toSign > 1 ? 's' : ''} des lieux à valider.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <FileTextIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Aucun état des lieux pour l’instant. Celui d’entrée est fait avec l’équipe du centre à la
            remise des clés ; il apparaîtra ici dès qu’il sera clos.
          </p>
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-4">
          {rows.map((row) => {
            const stage = row.stage === 'signed' ? 'signed' : 'to_sign'
            const StageIcon = stage === 'signed' ? CheckIcon : ClockIcon
            return (
              <li key={row.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                <article aria-labelledby={`edl-${row.id}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* L'étape se lit à l'icône et au libellé, pas à la seule couleur. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                        stage === 'signed'
                          ? 'bg-primary text-primary-foreground'
                          : 'border border-primary text-primary'
                      }`}
                    >
                      <StageIcon size={16} />
                      {inspectionStageClientLabels[stage]}
                    </span>
                    {several && <span className="text-muted-foreground">{row.clientName}</span>}
                  </div>
                  <div>
                    <h2 id={`edl-${row.id}`} className="text-base font-semibold">
                      {inspectionKindTitles[row.kind]} — {row.resourceName}
                    </h2>
                    <p className="text-sm text-muted-foreground tabular">
                      Établi le {formatDateTime(row.performedAt, timeZone)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {row.contractReference
                        ? `Contrat ${row.contractReference}`
                        : row.bookingTitle
                          ? `Réservation « ${row.bookingTitle} »`
                          : ''}
                    </p>
                  </div>
                  <Link
                    href={`/compte/etats-des-lieux/${row.id}`}
                    aria-describedby={`edl-${row.id}`}
                    className={`inline-flex min-h-11 items-center justify-center rounded-md px-5 py-2.5 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:self-start ${
                      stage === 'signed'
                        ? 'border border-border bg-white text-foreground hover:bg-muted'
                        : 'bg-primary text-primary-foreground hover:bg-primary-hover'
                    }`}
                  >
                    {stage === 'signed' ? 'Consulter' : 'Consulter et valider'}
                  </Link>
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
