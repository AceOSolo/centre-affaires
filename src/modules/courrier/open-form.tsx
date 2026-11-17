import { DepositForm } from './depots-forms.tsx'

/**
 * Ouverture et numérisation d'un pli à l'initiative du centre : la prestation
 * facturée. Le contenu est déposé, relu dans l'aperçu, puis validé
 * (ADR 079) : le pli n'est noté ouvert, et le client prévenu, qu'à la
 * validation. Le fichier est obligatoire — une ouverture sans numérisation
 * laisserait le client payer pour une boîte aux lettres vide.
 *
 * Une ouverture demandée par le client se traite depuis sa demande
 * (`/courrier/demandes/…`).
 */
export function OpenForm({ mailItemId }: { mailItemId: string }) {
  return (
    <section aria-labelledby="ouvrir" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
      <div>
        <h2 id="ouvrir" className="text-sm font-semibold tracking-tight">
          Ouvrir et numériser
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Ouverture à l’initiative du centre. Elle sera comptée au relevé comme telle, à sa validation.
        </p>
      </div>
      <DepositForm mailItemId={mailItemId} requestId={null} purpose="opening" />
    </section>
  )
}
