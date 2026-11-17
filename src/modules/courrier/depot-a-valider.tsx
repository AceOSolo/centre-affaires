import { formatDateTime } from '../../lib/dates.ts'
import { DocumentPreview } from './apercu-document.tsx'
import type { ContentDraft } from './depots.ts'
import { DepositForm, DiscardDraftButton, ValidateDraftButton, type DraftReturn } from './depots-forms.tsx'

/** « 1,2 Mo », « 340 ko ». */
function formatBytes(bytes: number): string {
  const format = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
  return bytes >= 1024 * 1024
    ? `${format.format(bytes / 1024 / 1024)} Mo`
    : `${format.format(Math.max(1, Math.round(bytes / 1024)))} ko`
}

/**
 * Un contenu déposé, à valider (ADR 079) : l'aperçu du document, puis
 * « Valider et prévenir le client », seul geste qui le publie. Le fichier se
 * remplace tant qu'il n'est pas validé ; le dépôt s'abandonne.
 */
export function DraftReview({
  draft,
  timeZone,
  back,
}: {
  draft: ContentDraft
  timeZone: string
  back: DraftReturn
}) {
  const deposited = formatDateTime(draft.createdAt, timeZone)
  const what = draft.purpose === 'scan' ? 'La numérisation' : 'Le contenu'
  return (
    <section
      id="a-valider"
      aria-labelledby="a-valider-titre"
      className="flex scroll-mt-24 flex-col gap-4 rounded-lg border border-accent/40 bg-white px-5 py-4"
    >
      <div>
        <h2 id="a-valider-titre" className="text-base font-semibold tracking-tight">
          {draft.purpose === 'scan' ? 'Numérisation à valider' : 'Contenu à valider'}
        </h2>
        <p className="mt-1 text-sm tabular">
          Déposé le {deposited}
          {draft.uploadedByName && ` par ${draft.uploadedByName}`} ·{' '}
          {draft.pageCount !== null && `${draft.pageCount} page${draft.pageCount > 1 ? 's' : ''} · `}
          {formatBytes(draft.byteSize)}
        </p>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          {what} n’est pas encore visible pour le client. Relisez chaque page : lisible, complète, du bon
          pli. À la validation, {draft.purpose === 'scan' ? 'la demande est faite' : 'le pli est noté ouvert'}, le
          client voit le document dans son espace et en est prévenu par courriel.
        </p>
      </div>

      <DocumentPreview scanId={draft.id} contentType={draft.contentType} label={`Contenu déposé le ${deposited}`} />

      <ValidateDraftButton draftId={draft.id} back={back} />

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Remplacer le fichier</summary>
        <div className="mt-3">
          <DepositForm mailItemId={draft.mailItemId} requestId={draft.mailRequestId} purpose={draft.purpose} replace />
        </div>
      </details>
      <DiscardDraftButton draftId={draft.id} back={back} />
    </section>
  )
}
