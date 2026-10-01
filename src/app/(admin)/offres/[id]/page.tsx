import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { billingPeriodLabels } from '../../../../modules/contrats/labels.ts'
import { SuccessNotice, dangerButtonClass } from '../../../../modules/facturation/champs.tsx'
import { OfferForm } from '../../../../modules/facturation/offer-form.tsx'
import { OfferItemForm } from '../../../../modules/facturation/offer-item-form.tsx'
import { OfferQuoteTable, OfferQuoteTotals } from '../../../../modules/facturation/offer-quote.tsx'
import {
  archiveOfferAction,
  removeOfferItemAction,
} from '../../../../modules/facturation/offres-actions.ts'
import { priceOffer } from '../../../../modules/facturation/offres-prix.ts'
import {
  countContractsFromOffer,
  findOffer,
  loadOfferCatalogue,
  toOfferInput,
  toOfferLineInput,
} from '../../../../modules/facturation/offres-queries.ts'
import { offerItemToValues } from '../../../../modules/facturation/offres-regles.ts'
import { resourceTypes } from '../../../../modules/ressources/schema.ts'

export const metadata = { title: 'Offre groupée' }

/** Confirmations après écriture. Une `Map` : `?enregistre=constructor` ne trouve rien. */
const notices = new Map([
  ['creee', 'Offre créée. Ajoutez-lui ses ressources et ses services.'],
  ['modifiee', 'Offre enregistrée.'],
  ['archivee', 'Offre archivée.'],
  ['ligne-ajoutee', 'Ligne ajoutée.'],
  ['ligne-modifiee', 'Ligne enregistrée.'],
  ['ligne-retiree', 'Ligne retirée de l’offre.'],
])

export default async function OfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ enregistre?: string; ligne?: string }>
}) {
  await requirePermission('services.gerer')
  const [{ id }, { enregistre, ligne }, tenant] = await Promise.all([
    params,
    searchParams,
    currentTenant(),
  ])
  const offer = await findOffer(id)
  if (!offer) notFound()

  const [catalogue, contractCount] = await Promise.all([
    loadOfferCatalogue(todayIsoDate(tenant.timezone)),
    countContractsFromOffer(offer.id),
  ])
  const input = toOfferInput(offer)
  const quote = priceOffer(input, catalogue)
  const archived = Boolean(offer.deletedAt)
  const notice = typeof enregistre === 'string' ? notices.get(enregistre) : undefined
  const editedItem = !archived ? offer.items.find((item) => item.id === ligne) : undefined

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/offres" className="text-sm text-muted-foreground hover:underline">
          ← Offres groupées
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{offer.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              archived ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'
            }`}
          >
            {archived ? 'Archivée' : 'Proposée'}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Facturation {billingPeriodLabels[offer.billingPeriod].toLowerCase()} ·{' '}
          {offer.commitmentMonths
            ? `engagement de ${offer.commitmentMonths} mois`
            : 'sans engagement'}{' '}
          · {contractCount === 0
            ? 'aucun contrat tiré de cette offre'
            : `${contractCount} contrat${contractCount > 1 ? 's' : ''} tiré${contractCount > 1 ? 's' : ''} de cette offre`}
        </p>
        {offer.description && (
          <p className="mt-2 max-w-prose whitespace-pre-line text-sm">{offer.description}</p>
        )}
      </div>

      {notice && <SuccessNotice>{notice}</SuccessNotice>}

      <section id="lignes" aria-labelledby="lignes-titre" className="flex flex-col gap-3">
        <h2 id="lignes-titre" className="text-sm font-semibold tracking-tight">
          Composition et prix{' '}
          <span className="font-normal text-muted-foreground">({offer.items.length})</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Prix calculés au catalogue du jour : grille par défaut du centre pour les ressources,
          prix des services. Les contrats tirés de l’offre copient ses lignes : les modifier ici ne
          change aucun contrat.
        </p>
        {offer.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Aucune ligne.{' '}
            {archived
              ? 'Cette offre archivée n’en a jamais eu.'
              : 'Ajoutez ci-dessous une ressource, un type de ressource ou un service.'}
          </p>
        ) : (
          <>
            <OfferQuoteTable
              quote={quote}
              caption={`Lignes de l’offre ${offer.name}`}
              actions={
                archived
                  ? undefined
                  : (line) => (
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/offres/${offer.id}?ligne=${line.id}#ligne-form`}
                          aria-label={`Modifier la ligne ${line.label}`}
                          className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Modifier
                        </Link>
                        <form action={removeOfferItemAction}>
                          <input type="hidden" name="offerId" value={offer.id} />
                          <input type="hidden" name="itemId" value={line.id} />
                          <button
                            type="submit"
                            aria-label={`Retirer la ligne ${line.label}`}
                            className="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                          >
                            Retirer
                          </button>
                        </form>
                      </div>
                    )
              }
            />
            <OfferQuoteTotals quote={quote} billingPeriod={offer.billingPeriod} />
          </>
        )}
      </section>

      {!archived && (
        <section
          id="ligne-form"
          aria-labelledby="ligne-form-titre"
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
        >
          <h2 id="ligne-form-titre" className="text-sm font-semibold tracking-tight">
            {editedItem ? 'Modifier la ligne' : 'Ajouter une ligne'}
          </h2>
          {/* Remonté après chaque écriture (ligne ajoutée, modifiée, retirée) :
              le formulaire repart vide au lieu de garder la ligne enregistrée. */}
          <OfferItemForm
            key={`${editedItem?.id ?? 'ajout'}-${offer.items.length}`}
            offerId={offer.id}
            offer={input}
            catalogue={catalogue}
            resourceTypes={resourceTypes}
            editing={
              editedItem
                ? { itemId: editedItem.id, values: offerItemToValues(toOfferLineInput(editedItem)) }
                : undefined
            }
          />
        </section>
      )}

      {!archived && (
        <section aria-labelledby="entete-titre" className="flex flex-col gap-3">
          <h2 id="entete-titre" className="text-sm font-semibold tracking-tight">
            Nom, facturation et engagement
          </h2>
          <OfferForm
            id={offer.id}
            defaults={{
              name: offer.name,
              description: offer.description ?? '',
              billingPeriod: offer.billingPeriod,
              commitmentMonths: offer.commitmentMonths ? String(offer.commitmentMonths) : '',
            }}
          />
        </section>
      )}

      {!archived && (
        <form action={archiveOfferAction} className="rounded-lg border border-border bg-white px-5 py-4">
          <input type="hidden" name="id" value={offer.id} />
          <p className="text-sm font-medium text-foreground">Archiver l’offre</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Elle n’est plus proposée. Les contrats qui en ont été tirés n’en dépendent pas.
          </p>
          <button type="submit" className={`mt-3 ${dangerButtonClass}`}>
            Archiver
          </button>
        </form>
      )}
    </div>
  )
}
