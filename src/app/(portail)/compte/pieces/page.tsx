import Link from 'next/link'

import { CheckIcon, ClockIcon, FileTextIcon, TriangleAlertIcon } from '../../../../components/ui/icons.tsx'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { DepositForm } from '../../../../modules/clients/pieces-depot.tsx'
import { loadClientDocumentSpace } from '../../../../modules/clients/pieces-queries.ts'
import {
  clientStateLabels,
  formatBytes,
  missingCount,
  situationLabels,
  type ChecklistState,
} from '../../../../modules/clients/pieces-regles.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'

export const metadata = { title: 'Pièces justificatives' }

/** L'état se lit à l'icône et au libellé ; la teinte ne fait que l'appuyer. */
const stateStyles: Record<ChecklistState, string> = {
  missing: 'border border-primary text-primary',
  received: 'border border-accent bg-accent/10 text-primary',
  accepted: 'bg-primary text-primary-foreground',
  refused: 'border border-destructive/40 bg-destructive/5 text-destructive',
}
const stateIcons = {
  missing: FileTextIcon,
  received: ClockIcon,
  accepted: CheckIcon,
  refused: TriangleAlertIcon,
} satisfies Record<ChecklistState, unknown>

/**
 * Pièces justificatives de la domiciliation (ADR 075) : ce que le centre doit
 * vérifier avant de domicilier la société — pièce d'identité du dirigeant,
 * Kbis ou projet de statuts, justificatif de domicile, selon la liste du
 * centre et la situation de la société. Le client dépose chaque pièce, voit
 * où elle en est, et en redépose une refusée.
 *
 * Mobile d'abord : une carte par pièce, le dépôt en pleine largeur, 44 px.
 */
export default async function ClientDocumentsPage() {
  const { accounts } = await requireClientAccount()
  const [spaces, timeZone] = await Promise.all([loadClientDocumentSpace(accounts), currentTimeZone()])
  const several = spaces.length > 1

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Pièces justificatives</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Pour domicilier votre société, le centre doit vérifier ces pièces. Déposez chacune en PDF ou en photo :
          l’équipe la vérifie et vous prévient si elle doit être remplacée. Vos pièces sont chiffrées et
          chaque consultation est enregistrée.
        </p>
        {spaces.some((space) => space.items.some((item) => item.canDeposit)) && (
          <p className="mt-2 text-sm text-muted-foreground">
            Les champs marqués{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
            <span className="sr-only">d’un astérisque</span> sont obligatoires.
          </p>
        )}
      </div>

      {spaces.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <FileTextIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mx-auto mt-3 max-w-prose text-muted-foreground">
            Aucune pièce à déposer pour l’instant. Les pièces sont demandées pour une domiciliation : faites votre
            demande depuis la{' '}
            <Link href="/" className="font-medium text-primary underline underline-offset-2">
              page d’accueil du site
            </Link>
            , elles apparaîtront ici.
          </p>
        </div>
      ) : (
        spaces.map((space) => {
          const missing = missingCount(space.items)
          return (
            <section
              key={space.clientId}
              aria-labelledby={`pieces-${space.clientId}`}
              className="flex max-w-3xl flex-col gap-4"
            >
              <div>
                <h2 id={`pieces-${space.clientId}`} className="text-lg font-semibold tracking-tight">
                  {several ? space.clientName : 'Pièces demandées'}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {space.situation ? situationLabels[space.situation] : situationLabels.registered}
                  {' · '}
                  {missing === 0
                    ? 'toutes les pièces sont déposées.'
                    : `${missing} pièce${missing > 1 ? 's' : ''} à déposer.`}
                </p>
              </div>

              {space.items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-sm text-muted-foreground">
                  Le centre ne demande aucune pièce pour l’instant. Il vous contactera si besoin.
                </p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {space.items.map((item) => {
                    const StateIcon = stateIcons[item.state]
                    const titleId = `piece-${space.clientId}-${item.kind.code}`
                    return (
                      <li key={item.kind.code} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                        <article aria-labelledby={titleId} className="flex flex-col gap-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h3 id={titleId} className="text-base font-semibold">
                                {item.kind.label}
                              </h3>
                              {item.kind.help && <p className="text-sm text-muted-foreground">{item.kind.help}</p>}
                            </div>
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${stateStyles[item.state]}`}
                            >
                              <StateIcon size={16} />
                              {clientStateLabels[item.state]}
                            </span>
                          </div>

                          {item.latest && (
                            <p className="text-sm text-muted-foreground tabular">
                              Déposée le {formatDateTime(item.latest.createdAt, timeZone)}
                              {' · '}
                              {formatBytes(item.latest.byteSize)}
                              {!item.latest.purged && (
                                <>
                                  {' · '}
                                  <a
                                    href={`/compte/pieces/${item.latest.id}`}
                                    target="_blank"
                                    rel="noopener"
                                    className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-2 hover:underline sm:min-h-0"
                                  >
                                    Voir le fichier
                                    <span className="sr-only"> : {item.kind.label} (nouvel onglet)</span>
                                  </a>
                                </>
                              )}
                            </p>
                          )}
                          {item.state === 'refused' && item.latest?.refusalReason && (
                            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
                              <span className="font-medium">Motif du refus : </span>
                              <span className="whitespace-pre-line">{item.latest.refusalReason}</span>
                            </p>
                          )}

                          <DepositForm
                            clientId={space.clientId}
                            kindCode={item.kind.code}
                            kindLabel={item.kind.label}
                            replacing={item.state === 'refused'}
                            open={item.canDeposit}
                          />
                        </article>
                      </li>
                    )
                  })}
                </ul>
              )}

              {space.others.length > 0 && (
                <details className="rounded-lg border border-border bg-white px-4 py-3 text-sm">
                  <summary className="min-h-11 cursor-pointer content-center font-medium">
                    Autres pièces déposées ({space.others.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {space.others.map((document) => (
                      <li key={document.id} className="text-muted-foreground tabular">
                        {document.kindLabel} — {clientStateLabels[document.status]}, déposée le{' '}
                        {formatDateTime(document.createdAt, timeZone)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
