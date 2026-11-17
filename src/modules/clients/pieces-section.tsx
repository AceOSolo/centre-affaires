import Link from 'next/link'

import { CheckIcon, ClockIcon, FileTextIcon, TriangleAlertIcon } from '../../components/ui/icons.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { listClientDocumentsForStaff, type StaffDepositedDocument } from './pieces-queries.ts'
import {
  formatBytes,
  situationLabels,
  staffStateLabels,
  toReviewCount,
  type ChecklistState,
} from './pieces-regles.ts'
import { AcceptSelectionForm, DocumentReviewActions } from './pieces-revue.tsx'

/** L'état se lit au libellé et à l'icône ; la teinte ne fait que l'appuyer. */
const stateStyles: Record<ChecklistState, string> = {
  missing: 'bg-muted text-muted-foreground',
  received: 'border border-accent bg-accent/10 text-primary',
  accepted: 'bg-primary text-primary-foreground',
  refused: 'bg-destructive/10 text-destructive',
}
const stateIcons = {
  missing: FileTextIcon,
  received: ClockIcon,
  accepted: CheckIcon,
  refused: TriangleAlertIcon,
} satisfies Record<ChecklistState, unknown>

function StateBadge({ state }: { state: ChecklistState }) {
  const Icon = stateIcons[state]
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${stateStyles[state]}`}>
      <Icon size={14} />
      {staffStateLabels[state]}
    </span>
  )
}

function Deposit({ document, timeZone }: { document: StaffDepositedDocument; timeZone: string }) {
  return (
    <span className="tabular">
      {formatDateTime(document.createdAt, timeZone)}
      <span className="block text-xs text-muted-foreground">
        par {document.uploadedBy} · {formatBytes(document.byteSize)}
      </span>
    </span>
  )
}

function OpenLink({ clientId, document, label }: { clientId: string; document: StaffDepositedDocument; label: string }) {
  if (document.purged) return <span className="text-xs text-muted-foreground">Effacée (conservation échue)</span>
  return (
    <a
      href={`/clients/${clientId}/pieces/${document.id}`}
      target="_blank"
      rel="noopener"
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      Ouvrir<span className="sr-only"> : {label} (nouvel onglet, consultation enregistrée)</span>
    </a>
  )
}

/**
 * Encart « Pièces justificatives » d'une entreprise (ADR 075), sur sa fiche
 * et sur son devis de domiciliation : les pièces demandées selon sa
 * situation, la dernière déposée pour chacune, et de quoi la valider ou la
 * refuser avec un motif. Chaque ouverture d'un fichier est journalisée.
 */
export async function ClientDocumentsSection({
  clientId,
  timeZone,
  canReview,
  canConfigure = false,
}: {
  clientId: string
  timeZone: string
  /** Droit `pieces.valider` : ouvrir, valider, refuser. */
  canReview: boolean
  /** Droit `centre.configurer` : le lien vers la liste des pièces demandées. */
  canConfigure?: boolean
}) {
  const view = await listClientDocumentsForStaff(clientId)
  const toReview = toReviewCount(view.items)
  const selectionId = `pieces-selection-${clientId}`
  const selectable = canReview && toReview > 1
  const older = view.items.flatMap((item) => item.history.slice(1))
  const accepted = view.items.filter((item) => item.state === 'accepted').length
  const summary =
    toReview > 0
      ? `${toReview} à vérifier`
      : `${accepted} validée${accepted > 1 ? 's' : ''} sur ${view.items.length}`

  return (
    <section id="pieces" aria-labelledby="pieces-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="pieces-titre" className="text-sm font-semibold tracking-tight">
          Pièces justificatives{' '}
          <span className="font-normal text-muted-foreground">({summary})</span>
        </h2>
        {canConfigure && (
          <Link href="/reglages/pieces" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
            Pièces demandées
          </Link>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {view.situation ? situationLabels[view.situation] : 'Situation non renseignée : traitée comme une société immatriculée'}.
        {' '}Le client dépose ses pièces depuis son espace ; ouvrez chacune, puis validez-la ou refusez-la avec un motif — il
        est prévenu par courriel.
      </p>

      {view.items.length === 0 && view.others.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-sm text-muted-foreground">
          Aucune pièce demandée : la liste du centre est vide.
          {canConfigure && (
            <>
              {' '}
              <Link href="/reglages/pieces" className="font-medium text-primary underline underline-offset-2">
                Régler les pièces demandées
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table aria-labelledby="pieces-titre" className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <tr>
                {selectable && (
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Sélection</span>
                  </th>
                )}
                <th scope="col" className="px-4 py-2">Pièce</th>
                <th scope="col" className="px-4 py-2">État</th>
                <th scope="col" className="px-4 py-2">Déposée le</th>
                <th scope="col" className="px-4 py-2">Fichier</th>
                {canReview && (
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {[
                ...view.items.map((item) => ({ key: item.kind.code, label: item.kind.label, state: item.state, document: item.latest })),
                ...view.others.map((document) => ({
                  key: document.id,
                  label: `${document.kindLabel} (plus demandée)`,
                  state: document.status as ChecklistState,
                  document,
                })),
              ].map(({ key, label, state, document }) => (
                <tr key={key} className="border-b border-border align-top last:border-0">
                  {selectable && (
                    <td className="px-4 py-2">
                      {state === 'received' && document && (
                        <input
                          type="checkbox"
                          name="documentId"
                          value={document.id}
                          form={selectionId}
                          aria-label={`Sélectionner : ${label}`}
                          className="size-4 accent-primary"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2 font-medium">{label}</td>
                  <td className="px-4 py-2">
                    <StateBadge state={state} />
                    {state === 'refused' && document?.refusalReason && (
                      <span className="mt-1 block max-w-xs whitespace-pre-line text-xs text-foreground">
                        Motif : {document.refusalReason}
                      </span>
                    )}
                    {document?.reviewedByName && document.reviewedAt && (
                      <span className="mt-1 block text-xs text-muted-foreground tabular">
                        par {document.reviewedByName}, le {formatDateTime(document.reviewedAt, timeZone)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{document ? <Deposit document={document} timeZone={timeZone} /> : '—'}</td>
                  <td className="px-4 py-2">
                    {document && canReview ? <OpenLink clientId={clientId} document={document} label={label} /> : '—'}
                  </td>
                  {canReview && (
                    <td className="px-4 py-2">
                      {document && !document.purged && (
                        <DocumentReviewActions documentId={document.id} label={label} status={document.status} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canReview && <AcceptSelectionForm formId={selectionId} count={toReview} />}

      {older.length > 0 && (
        <details className="rounded-lg border border-border bg-white px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Dépôts précédents ({older.length})</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {older.map((document) => (
              <li key={document.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{document.kindLabel}</span>
                <StateBadge state={document.status} />
                <span className="text-muted-foreground tabular">
                  déposée le {formatDateTime(document.createdAt, timeZone)} par {document.uploadedBy}
                </span>
                {document.refusalReason && <span className="text-xs">Motif : {document.refusalReason}</span>}
                {canReview && <OpenLink clientId={clientId} document={document} label={document.kindLabel} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
