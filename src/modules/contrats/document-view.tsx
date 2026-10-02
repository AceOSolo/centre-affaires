import { formatCents } from '../facturation/tarifs.ts'
import type { ContractSnapshot, SnapshotParty } from './instantane.ts'
import { formatBpAsPercent } from './lignes.ts'
import { formatCalendarDate } from './occupation.ts'

/**
 * Document de contrat ou d'avenant (R12, ADR 025), rendu depuis son
 * instantané seul : rien n'est relu du contrat, du client ni du centre. Le
 * PDF est cette vue, imprimée par le navigateur (feuille d'impression de la
 * page) — aucune bibliothèque de génération.
 *
 * Composant serveur, sans état : la même vue sert l'aperçu d'un brouillon et
 * chaque version archivée.
 */

/** D'où vient le document affiché : archivé (avec son empreinte) ou aperçu. */
export type DocumentProvenance =
  | {
      kind: 'archived'
      version: number
      sha256: string
      intact: boolean
      archivedAt: string
      archivedBy: string | null
    }
  | { kind: 'preview' }

function Party({ title, party }: { title: string; party: SnapshotParty }) {
  const identity = [
    party.legalForm,
    party.shareCapitalCents !== null
      ? `au capital de ${formatCents(party.shareCapitalCents)}`
      : null,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="break-inside-avoid">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-fonce">{title}</h3>
      <p className="mt-1 font-semibold">{party.name}</p>
      {identity && <p>{identity}</p>}
      {party.address.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {party.siren && (
        <p>
          SIREN {party.siren}
          {party.rcsCity ? ` — RCS ${party.rcsCity}` : ''}
        </p>
      )}
      {party.siret && <p>SIRET {party.siret}</p>}
      {party.vatNumber && <p>TVA intracommunautaire {party.vatNumber}</p>}
      {party.email && <p>{party.email}</p>}
      {party.phone && <p>{party.phone}</p>}
    </div>
  )
}

function Article({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-6 break-inside-avoid-page">
      <h2 className="text-sm font-semibold text-brand-fonce">
        Article {number} — {title}
      </h2>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </section>
  )
}

export function ContractDocumentView({
  snapshot,
  provenance,
}: {
  snapshot: ContractSnapshot
  provenance: DocumentProvenance
}) {
  const money = (cents: number) => formatCents(cents, snapshot.contract.currency)
  const { contract, amendment, price, conditions } = snapshot
  const period = contract.billingPeriodLabel.toLowerCase()
  const title = amendment
    ? `Avenant n° ${amendment.number} au contrat ${contract.reference}`
    : `Contrat de prestations de services — ${contract.contractTypeLabel}`

  const priceTable = (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">Prix, ligne à ligne</caption>
        <thead>
          <tr className="border-b border-foreground/40">
            <th scope="col" className="py-1.5 pr-2 font-semibold">Désignation</th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">Qté</th>
            <th scope="col" className="py-1.5 pr-2 font-semibold">Unité</th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">PU HT</th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">Remise</th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">TVA</th>
            <th scope="col" className="py-1.5 text-right font-semibold">Montant HT</th>
          </tr>
        </thead>
        <tbody>
          {price.lines.map((line, index) => (
            <tr key={index} className="border-b border-border">
              <td className="py-1.5 pr-2">
                {line.description}
                {line.target && line.target !== line.description && (
                  <span className="block text-muted-foreground">{line.target}</span>
                )}
                {!line.isRecurring && <span className="block text-muted-foreground">Due une fois</span>}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{line.quantity}</td>
              <td className="py-1.5 pr-2">{line.unitLabel}</td>
              <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums">{money(line.unitPriceCents)}</td>
              <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums">
                {line.discountBp !== null
                  ? `${formatBpAsPercent(line.discountBp)} %`
                  : line.discountAmountCents !== null
                    ? money(line.discountAmountCents)
                    : '—'}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatBpAsPercent(line.vatRateBp)} %</td>
              <td className="whitespace-nowrap py-1.5 text-right tabular-nums">{money(line.netAmountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={6} className="pt-2 pr-2 text-right font-semibold">
              Total HT par période ({period})
            </th>
            <td className="whitespace-nowrap pt-2 text-right font-semibold tabular-nums">
              {money(price.totals.recurringNetCents)}
            </td>
          </tr>
          {price.totals.recurringVat.map((group) => (
            <tr key={group.vatRateBp}>
              <th scope="row" colSpan={6} className="pr-2 text-right font-normal">
                TVA {formatBpAsPercent(group.vatRateBp)} % sur {money(group.baseCents)}
              </th>
              <td className="whitespace-nowrap text-right tabular-nums">{money(group.vatCents)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={6} className="pr-2 text-right font-semibold">
              Total TTC par période
            </th>
            <td className="whitespace-nowrap text-right font-semibold tabular-nums">
              {money(price.totals.recurringGrossCents)}
            </td>
          </tr>
          {price.totals.oneOffNetCents > 0 && (
            <tr>
              <th scope="row" colSpan={6} className="pr-2 text-right font-normal">
                Frais dus une fois : {money(price.totals.oneOffNetCents)} HT, soit
              </th>
              <td className="whitespace-nowrap text-right tabular-nums">
                {money(price.totals.oneOffGrossCents)} TTC
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  )

  const subscriptions =
    snapshot.subscriptions.length > 0 ? (
      <div>
        <p>Services souscrits avec le contrat :</p>
        <ul className="mt-1 list-disc pl-5">
          {snapshot.subscriptions.map((subscription, index) => (
            <li key={index}>
              {subscription.serviceName}
              {subscription.includedQuantity !== null
                ? ` : ${subscription.includedQuantity} inclus par mois, puis ${money(subscription.unitPriceCents)} HT l’unité`
                : ` : ${money(subscription.unitPriceCents)} HT, ${subscription.unitLabel.toLowerCase()}`}
              {subscription.discountBp !== null && `, remisé de ${formatBpAsPercent(subscription.discountBp)} %`}
              {subscription.discountAmountCents !== null && `, remisé de ${money(subscription.discountAmountCents)}`}
              {` (TVA ${formatBpAsPercent(subscription.vatRateBp)} %).`}
            </li>
          ))}
        </ul>
      </div>
    ) : null

  const billing = (
    <>
      <p>
        Les prestations récurrentes sont facturées par période civile ({period}),{' '}
        {conditions.billingTimingLabel}. {conditions.prorataLabel}
      </p>
      <p>
        Les factures sont payables à {conditions.paymentTermsDays} jours à compter de leur date
        d’émission.
        {conditions.vatOnDebits ? ' TVA acquittée d’après les débits.' : ''}
      </p>
      <p>{conditions.latePaymentPenaltyText}</p>
      <p>
        Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement :{' '}
        {formatCents(conditions.recoveryIndemnityCents)}.
      </p>
      <p>{conditions.earlyPaymentDiscountText}</p>
    </>
  )

  // Les articles, numérotés dans l'ordre où ils figurent.
  const articles: { title: string; content: React.ReactNode }[] = amendment
    ? [
        {
          title: 'Objet de l’avenant',
          content: (
            <p>
              Le présent avenant modifie le contrat {contract.reference}, conclu à compter du{' '}
              {formatCalendarDate(contract.startsOn)}, à partir du{' '}
              <strong>{formatCalendarDate(amendment.effectiveOn)}</strong>.
              {amendment.reason ? ` Objet : ${amendment.reason}.` : ''}
            </p>
          ),
        },
        ...(amendment.changesResource
          ? [
              {
                title: 'Ressource mise à disposition',
                content: (
                  <p>
                    {amendment.previousResource
                      ? `${amendment.previousResource.typeLabel} ${amendment.previousResource.name} (${amendment.previousResource.code}) jusqu’à la veille de la date d’effet`
                      : 'Aucune ressource jusqu’à la veille de la date d’effet'}
                    {'. '}
                    {snapshot.resource
                      ? `À partir de la date d’effet : ${snapshot.resource.typeLabel} ${snapshot.resource.name} (${snapshot.resource.code}).`
                      : 'À partir de la date d’effet, aucune ressource n’est plus mise à disposition.'}
                  </p>
                ),
              },
            ]
          : []),
        {
          title: amendment.priceChanged ? 'Nouveau prix' : 'Prix',
          content: (
            <>
              <p>
                {amendment.priceChanged
                  ? `À partir de la date d’effet, le prix est fixé comme suit ; il remplace l’ensemble des stipulations de prix antérieures. Facturation ${period}.`
                  : `Le prix reste celui en vigueur à la date d’effet, rappelé ci-dessous. Facturation ${period}.`}
              </p>
              {priceTable}
            </>
          ),
        },
        { title: 'Facturation et règlement', content: billing },
        {
          title: 'Autres stipulations',
          content: <p>Les autres stipulations du contrat demeurent inchangées.</p>,
        },
      ]
    : [
        {
          title: 'Objet',
          content: (
            <>
              <p>
                Le prestataire fournit au client des prestations de centre d’affaires —{' '}
                {contract.contractTypeLabel.toLowerCase()}
                {contract.offerName ? `, selon l’offre « ${contract.offerName} »` : ''}.
              </p>
              <p>
                {snapshot.resource
                  ? `Ressource mise à disposition : ${snapshot.resource.typeLabel} ${snapshot.resource.name} (${snapshot.resource.code}).`
                  : 'Aucune ressource n’est attribuée en propre au client.'}
              </p>
            </>
          ),
        },
        {
          title: 'Durée',
          content: (
            <>
              <p>
                Le contrat prend effet le {formatCalendarDate(contract.startsOn)}
                {contract.endsOn
                  ? ` et prend fin le ${formatCalendarDate(contract.endsOn)}.`
                  : ', pour une durée indéterminée.'}
              </p>
              {contract.commitmentMonths && contract.commitmentEndsOn && (
                <p>
                  Le client s’engage pour {contract.commitmentMonths} mois, soit jusqu’au{' '}
                  {formatCalendarDate(contract.commitmentEndsOn)} inclus.
                </p>
              )}
              {contract.tacitRenewal && contract.renewalMonths && (
                <p>
                  À son terme, le contrat se renouvelle par tacite reconduction pour des périodes
                  de {contract.renewalMonths} mois, sauf résiliation dans le respect du préavis.
                </p>
              )}
            </>
          ),
        },
        {
          title: 'Prix',
          content: (
            <>
              <p>Prix hors taxes, par période de facturation ({period}).</p>
              {priceTable}
              {subscriptions}
            </>
          ),
        },
        { title: 'Facturation et règlement', content: billing },
        {
          title: 'Résiliation',
          content: (
            <p>
              Chaque partie peut mettre fin au contrat moyennant un préavis de{' '}
              {contract.noticeDays} jours, courant à compter de sa notification
              {contract.commitmentEndsOn
                ? `, sans que le contrat puisse prendre fin avant le ${formatCalendarDate(contract.commitmentEndsOn)}, terme de l’engagement, sauf accord des deux parties`
                : ''}
              .
            </p>
          ),
        },
      ]

  return (
    <article className="mx-auto w-full max-w-[210mm] bg-white px-4 py-6 text-[13px] sm:px-[16mm] sm:py-[14mm] leading-relaxed text-foreground shadow-sm print:max-w-none print:p-0 print:shadow-none">
      {provenance.kind === 'preview' && (
        <p className="mb-6 rounded-md border-2 border-dashed border-brand-fonce/50 px-4 py-2 text-center text-sm font-semibold uppercase tracking-wide text-brand-fonce">
          Projet — aperçu non archivé, sans valeur contractuelle
        </p>
      )}

      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-brand-fonce pb-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{snapshot.seller.name}</p>
          <h1 className="mt-1 text-xl font-semibold text-brand-fonce">{title}</h1>
          {contract.offerName && !amendment && <p className="mt-1">Offre : {contract.offerName}</p>}
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-xs">
          <dt className="text-muted-foreground">Contrat</dt>
          <dd className="tabular font-medium">{contract.reference}</dd>
          <dt className="text-muted-foreground">Établi le</dt>
          <dd className="tabular">{formatCalendarDate(snapshot.issuedOn)}</dd>
          {amendment && (
            <>
              <dt className="text-muted-foreground">Date d’effet</dt>
              <dd className="tabular">{formatCalendarDate(amendment.effectiveOn)}</dd>
            </>
          )}
        </dl>
      </header>

      <section className="mt-6 grid gap-6 sm:grid-cols-2 print:grid-cols-2" aria-label="Parties">
        <Party title="Le prestataire" party={snapshot.seller} />
        <Party title="Le client" party={snapshot.buyer} />
      </section>

      {articles.map((entry, index) => (
        <Article key={entry.title} number={index + 1} title={entry.title}>
          {entry.content}
        </Article>
      ))}

      <section className="mt-8 break-inside-avoid" aria-label="Signatures">
        <p>
          Fait en deux exemplaires
          {snapshot.seller.city ? `, à ${snapshot.seller.city}` : ''}, le{' '}
          {formatCalendarDate(snapshot.issuedOn)}.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-6">
          {['Pour le prestataire', 'Pour le client'].map((label) => (
            <div key={label} className="h-28 rounded-md border border-border px-3 py-2">
              <p className="text-xs font-semibold">{label}</p>
              <p className="text-xs text-muted-foreground">Nom, qualité, signature</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-8 border-t border-border pt-3 text-[11px] text-muted-foreground">
        {provenance.kind === 'archived' ? (
          <>
            <p>
              Document version {provenance.version}, archivé le {provenance.archivedAt}
              {provenance.archivedBy ? ` par ${provenance.archivedBy}` : ''}.
            </p>
            <p className="break-all">Empreinte SHA-256 : {provenance.sha256}</p>
            <p className="font-medium text-foreground">
              {provenance.intact
                ? 'Empreinte vérifiée : le document est celui qui a été archivé.'
                : 'Empreinte non conforme : le document a été modifié depuis son archivage.'}
            </p>
          </>
        ) : (
          <p>Aperçu établi à partir des données actuelles. Il est archivé, avec son empreinte, à l’activation du contrat ou à la signature de l’avenant.</p>
        )}
      </footer>
    </article>
  )
}
