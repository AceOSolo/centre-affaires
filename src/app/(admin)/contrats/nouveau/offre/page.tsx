import Link from 'next/link'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { listClients } from '../../../../../modules/clients/queries.ts'
import { isCalendarDate } from '../../../../../modules/contrats/formulaire.ts'
import { billingPeriodLabels } from '../../../../../modules/contrats/labels.ts'
import { formatBpAsPercent, lineToFormValues } from '../../../../../modules/contrats/lignes.ts'
import { OfferContractForm } from '../../../../../modules/contrats/offer-contract-form.tsx'
import { actToFormValues, proposeContractFromOffer } from '../../../../../modules/contrats/offres.ts'
import {
  findOfferForContract,
  listCatalogRates,
  listOffersForContract,
  loadLinesCatalog,
} from '../../../../../modules/contrats/offres-queries.ts'
import { listResources } from '../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouveau contrat depuis une offre' }

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

/**
 * Nouveau contrat tiré d'une offre groupée (R09, R12, ADR 024).
 *
 * Deux temps : choisir l'offre, le client et la date de début (un formulaire
 * en GET, sans JavaScript) ; puis ajuster la proposition — lignes, actes
 * inclus, engagement — avant de créer le brouillon. La création manuelle
 * reste sur `/contrats/nouveau`.
 */
export default async function NewContractFromOfferPage({
  searchParams,
}: {
  searchParams: Promise<{ offre?: string; client?: string; debut?: string }>
}) {
  await requirePermission('contrats.creer')
  const { offre, client, debut } = await searchParams
  const tenant = await currentTenant()
  const today = todayIsoDate(tenant.timezone)
  const [offers, clients] = await Promise.all([listOffersForContract(), listClients()])

  const chosen =
    offre && isUuid(offre) && client && clients.some((candidate) => candidate.id === client) && debut && isCalendarDate(debut)
      ? await findOfferForContract(offre)
      : undefined

  const header = (
    <div>
      <Link href="/contrats/nouveau" className="text-sm text-muted-foreground hover:underline">
        ← Nouveau contrat
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouveau contrat depuis une offre</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Les lignes de l’offre sont copiées dans le contrat, au prix de l’offre ou du catalogue, puis
        ajustées avant la création.
      </p>
    </div>
  )

  if (!chosen || !client || !debut) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {offers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
            Aucune offre groupée au catalogue. L’exploitant les compose dans le catalogue des
            services et des offres ; en attendant,{' '}
            <Link href="/contrats/nouveau" className="underline underline-offset-2">
              créez le contrat à la main
            </Link>
            .
          </p>
        ) : clients.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
            Aucun client enregistré.{' '}
            <Link href="/clients/nouveau" className="underline underline-offset-2">
              Créer un client
            </Link>{' '}
            avant d’établir un contrat.
          </p>
        ) : (
          <form method="get" className="flex max-w-3xl flex-col gap-5 rounded-lg border border-border bg-white px-5 py-4">
            {offre && !chosen && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Choisissez une offre, un client et une date de début valides.
              </p>
            )}
            <div>
              <label className="block text-sm font-medium" htmlFor="offre">Offre</label>
              <select id="offre" name="offre" required defaultValue={offre ?? ''} className={`${fieldClass} mt-1`}>
                <option value="" disabled>Choisir une offre…</option>
                {offers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} — {billingPeriodLabels[candidate.billingPeriod].toLowerCase()},{' '}
                    {candidate.itemCount} ligne{candidate.itemCount > 1 ? 's' : ''}
                    {candidate.commitmentMonths ? `, engagement ${candidate.commitmentMonths} mois` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium" htmlFor="client">Client</label>
                <select id="client" name="client" required defaultValue={client ?? ''} className={`${fieldClass} mt-1`}>
                  <option value="" disabled>Choisir un client…</option>
                  {clients.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="debut">Début du contrat</label>
                <input id="debut" name="debut" type="date" required defaultValue={debut ?? today} className={`${fieldClass} mt-1`} />
              </div>
            </div>
            <button
              type="submit"
              className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Préparer le contrat
            </button>
          </form>
        )}
      </div>
    )
  }

  const [rates, catalog, resources] = await Promise.all([
    listCatalogRates(debut),
    loadLinesCatalog(),
    listResources(),
  ])
  const proposal = proposeContractFromOffer(chosen, {
    rates,
    defaultVatRateBp: tenant.defaultVatRateBp,
  })

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <p>
          <strong className="font-medium">{chosen.name}</strong> — facturation{' '}
          {billingPeriodLabels[chosen.billingPeriod].toLowerCase()}
          {chosen.commitmentMonths ? `, engagement de ${chosen.commitmentMonths} mois` : ', sans engagement'}.
        </p>
        {proposal.warnings.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-warning-foreground">
            {proposal.warnings.map((warning) => (
              <li key={warning}>À vérifier : {warning}</li>
            ))}
          </ul>
        )}
      </div>
      <OfferContractForm
        offer={{ id: chosen.id, name: chosen.name }}
        defaults={{
          clientId: client,
          reference: '',
          contractType: proposal.contractType,
          resourceId: proposal.resourceId ?? '',
          startsOn: debut,
          endsOn: '',
          billingPeriod: proposal.billingPeriod,
          amount: '0',
          noticeDays: '90',
          ratePlanId: '',
          notes: '',
          vatRate: formatBpAsPercent(tenant.defaultVatRateBp),
          commitmentMonths: proposal.commitmentMonths ? String(proposal.commitmentMonths) : '',
          tacitRenewal: '',
          renewalMonths: '',
        }}
        initialLines={proposal.lines.map((line, index) => lineToFormValues(String(index), line))}
        initialActs={proposal.subscriptions.map((act, index) => actToFormValues(String(index), act))}
        catalog={catalog}
        clients={clients.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
        resources={resources}
        currency={chosen.currency}
      />
    </div>
  )
}
