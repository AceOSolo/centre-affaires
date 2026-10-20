import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { primaryButtonClass, secondaryButtonClass } from '../../../../modules/facturation/champs.tsx'
import { rateUnitLabels } from '../../../../modules/facturation/labels.ts'
import {
  CancelProposalDialog,
  ProposalActionButton,
  ProposalLineForm,
  ProposalNoteForm,
} from '../../../../modules/facturation/proposal-forms.tsx'
import { ProposalStatusBadge } from '../../../../modules/facturation/proposal-status.tsx'
import {
  removeProposalLineAction,
  reopenProposalAction,
  validateProposalAction,
} from '../../../../modules/facturation/propositions-actions.ts'
import { proposalGuidance, type LineFormValues } from '../../../../modules/facturation/propositions-ecran.ts'
import { findProposal, listServicesForProposal } from '../../../../modules/facturation/propositions-queries.ts'
import {
  describeSlot,
  lineAmountCents,
  proposalActions,
  proposalLineSourceLabels,
  proposalProductLabels,
  proposalTotals,
} from '../../../../modules/facturation/propositions.ts'
import type { ProposalLine } from '../../../../modules/facturation/schema-devis.ts'
import {
  basisPointsToInput,
  centsToInput,
  formatBasisPoints,
  formatCents,
} from '../../../../modules/facturation/tarifs.ts'
import { ChannelLabel } from '../../../../modules/reservations/canal.tsx'
import { describeAnswers, type Answers } from '../../../../modules/reservations/questionnaires.ts'

export const metadata = { title: 'Devis' }

/** Confirmations après écriture. Une `Map` : `?enregistre=constructor` ne trouve rien. */
const notices = new Map([
  ['cree', 'Devis créé. Ajoutez ses lignes, puis validez-le.'],
  ['ligne-ajoutee', 'Ligne ajoutée.'],
  ['ligne-modifiee', 'Ligne enregistrée.'],
  ['ligne-retiree', 'Ligne retirée du devis.'],
  ['note', 'Note enregistrée.'],
  ['valide', 'Devis validé : Dolibarr le reprendra à son prochain passage.'],
  ['brouillon', 'Devis remis en brouillon : Dolibarr ne le reprendra pas tant qu’il n’est pas validé.'],
  ['annule', 'Devis annulé.'],
])

function lineToValues(line: ProposalLine): LineFormValues {
  return {
    mode: 'manual',
    serviceId: line.serviceId ?? '',
    label: line.label,
    description: line.description ?? '',
    unit: line.unit,
    quantity: String(line.quantity),
    unitPrice: centsToInput(line.unitPriceCents),
    vatRate: basisPointsToInput(line.vatRateBp),
    discountPercent: line.discountBp === null ? '' : basisPointsToInput(line.discountBp),
    discountAmount: line.discountAmountCents === null ? '' : centsToInput(line.discountAmountCents),
  }
}

export default async function ProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ enregistre?: string; ligne?: string }>
}) {
  await requirePermission('demandes.traiter')
  const [{ id }, { enregistre, ligne }, tenant] = await Promise.all([params, searchParams, currentTenant()])
  if (!isUuid(id)) notFound()
  const proposal = await findProposal(id)
  if (!proposal) notFound()

  const timeZone = tenant.timezone
  const actions = proposalActions(proposal.status)
  const services = actions.edit ? await listServicesForProposal() : []
  const totals = proposalTotals(proposal.lines)
  const answers = describeAnswers(proposal.product, proposal.answers as Answers)
  const notice = typeof enregistre === 'string' ? notices.get(enregistre) : undefined
  const editedLine = actions.edit ? proposal.lines.find((line) => line.id === ligne) : undefined
  const bookingChangedAfterSending = Boolean(
    proposal.booking?.quotedAt && proposal.sentAt && proposal.booking.quotedAt > proposal.sentAt,
  )

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/devis" className="text-sm text-muted-foreground hover:underline">
          ← Devis
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Devis <span className="tabular">{proposal.number}</span>
          </h1>
          <ProposalStatusBadge status={proposal.status} />
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Produit :</dt>
            <dd>{proposalProductLabels[proposal.product]}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Canal :</dt>
            <dd>
              <ChannelLabel channel={proposal.channel} />
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Créé le</dt>
            <dd className="tabular">{formatDateTime(proposal.createdAt, timeZone)}</dd>
          </div>
          {proposal.validatedAt && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Validé le</dt>
              <dd className="tabular">
                {formatDateTime(proposal.validatedAt, timeZone)}
                {proposal.validatedByName ? `, par ${proposal.validatedByName}` : ', automatiquement'}
              </dd>
            </div>
          )}
          {proposal.sentAt && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Transmis le</dt>
              <dd className="tabular">{formatDateTime(proposal.sentAt, timeZone)}</dd>
            </div>
          )}
          {proposal.dolibarrRef && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Référence Dolibarr :</dt>
              <dd className="font-medium tabular">{proposal.dolibarrRef}</dd>
            </div>
          )}
          {proposal.outcomeAt && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Issue le</dt>
              <dd className="tabular">{formatDateTime(proposal.outcomeAt, timeZone)}</dd>
            </div>
          )}
        </dl>
      </div>

      {notice && <FlashNotice key={enregistre}>{notice}</FlashNotice>}

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
        <p className="text-sm">
          {proposalGuidance({
            status: proposal.status,
            product: proposal.product,
            lines: proposal.lines,
            hasBooking: Boolean(proposal.booking),
            dolibarrRef: proposal.dolibarrRef,
          })}
        </p>
        {proposal.status === 'cancelled' && (
          <p className="text-sm">
            <span className="text-muted-foreground">Annulé le </span>
            {proposal.cancelledAt ? formatDateTime(proposal.cancelledAt, timeZone) : '—'}
            <span className="text-muted-foreground"> · Motif : </span>
            {proposal.cancellationReason ?? '—'}
          </p>
        )}
        {(actions.validate || actions.reopen || actions.cancel) && (
          <div className="flex flex-wrap items-start gap-3">
            {actions.validate && (
              <ProposalActionButton
                action={validateProposalAction}
                fields={{ proposalId: proposal.id }}
                label="Valider le devis"
                pendingLabel="Validation…"
                className={primaryButtonClass}
                hint="Il partira vers Dolibarr, qui l’enverra au client."
              />
            )}
            {actions.reopen && (
              <ProposalActionButton
                action={reopenProposalAction}
                fields={{ proposalId: proposal.id }}
                label="Remettre en brouillon"
                pendingLabel="Retour en brouillon…"
                className={secondaryButtonClass}
                hint="Pour le modifier avant que Dolibarr le reprenne."
              />
            )}
            {actions.cancel && (
              <CancelProposalDialog proposalId={proposal.id} number={proposal.number} sent={proposal.status === 'sent'} />
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="destinataire-titre" className="rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="destinataire-titre" className="text-sm font-semibold tracking-tight">
            Destinataire
          </h2>
          <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            {proposal.client ? (
              <>
                <dt className="text-muted-foreground">Client</dt>
                <dd>
                  <Link href={`/clients/${proposal.client.id}`} className="text-primary underline-offset-2 hover:underline">
                    {proposal.client.name}
                  </Link>
                </dd>
                {proposal.client.siret && (
                  <>
                    <dt className="text-muted-foreground">SIRET</dt>
                    <dd className="tabular">{proposal.client.siret}</dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">Entreprise</dt>
                <dd>
                  {proposal.requesterCompany ?? '—'}{' '}
                  <span className="text-muted-foreground">(prospect, sans fiche client)</span>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Contact</dt>
            <dd>{proposal.requesterName ?? '—'}</dd>
            <dt className="text-muted-foreground">Courriel</dt>
            <dd>
              {(proposal.requesterEmail ?? proposal.client?.email) ? (
                <a
                  href={`mailto:${proposal.requesterEmail ?? proposal.client?.email}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {proposal.requesterEmail ?? proposal.client?.email}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-muted-foreground">Téléphone</dt>
            <dd>
              {(proposal.requesterPhone ?? proposal.client?.phone) ? (
                <a
                  href={`tel:${(proposal.requesterPhone ?? proposal.client?.phone ?? '').replace(/\s/g, '')}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {proposal.requesterPhone ?? proposal.client?.phone}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </section>

        <section aria-labelledby="reservation-titre" className="rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="reservation-titre" className="text-sm font-semibold tracking-tight">
            Réservation
          </h2>
          {proposal.booking ? (
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <p>
                <Link href={`/reservations/${proposal.booking.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                  {proposal.booking.resourceName}
                </Link>
              </p>
              <p className="first-letter:uppercase">{describeSlot(proposal.booking.startsAt, proposal.booking.endsAt, timeZone)}</p>
              {proposal.booking.status === 'cancelled' && (
                <p className="text-muted-foreground">Réservation annulée : le créneau est libre.</p>
              )}
              {bookingChangedAfterSending && (
                <p role="note" className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-warning-foreground">
                  <strong className="font-medium">Attention :</strong> la réservation a été modifiée après l’envoi du devis :
                  vérifiez dans Dolibarr.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {proposal.product === 'domiciliation'
                ? 'Une domiciliation ne se réserve pas au calendrier : elle se fait par contrat.'
                : 'Aucune réservation rattachée.'}
            </p>
          )}
        </section>
      </div>

      <section aria-labelledby="reponses-titre" className="rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="reponses-titre" className="text-sm font-semibold tracking-tight">
          Réponses au questionnaire
        </h2>
        {answers.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Aucune réponse enregistrée.</p>
        ) : (
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(10rem,auto)_1fr]">
            {answers.map((answer) => (
              <div key={answer.label} className="contents">
                <dt className="text-muted-foreground">{answer.label}</dt>
                <dd>{answer.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {proposal.message && (
          <div className="mt-4">
            <h3 className="text-sm font-medium">Message du demandeur</h3>
            <p className="mt-1 max-w-prose whitespace-pre-line rounded-md bg-muted p-3 text-sm">{proposal.message}</p>
          </div>
        )}
      </section>

      <section id="note" aria-labelledby="note-titre" className="rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="note-titre" className="sr-only">
          Note de l’accueil
        </h2>
        {actions.edit ? (
          <ProposalNoteForm key={proposal.staffNote ?? ''} proposalId={proposal.id} staffNote={proposal.staffNote ?? ''} />
        ) : (
          <>
            <p className="text-sm font-medium">Note de l’accueil</p>
            <p className="mt-1 max-w-prose whitespace-pre-line text-sm text-muted-foreground">
              {proposal.staffNote ?? 'Aucune note.'}
            </p>
          </>
        )}
      </section>

      <section id="lignes" aria-labelledby="lignes-titre" className="flex flex-col gap-3">
        <h2 id="lignes-titre" className="text-sm font-semibold tracking-tight">
          Lignes <span className="font-normal text-muted-foreground">({proposal.lines.length})</span>
        </h2>
        {proposal.lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Aucune ligne.{' '}
            {actions.edit
              ? 'Ajoutez ci-dessous un service du catalogue ou une ligne saisie : c’est le prix que Dolibarr reprendra.'
              : 'Ce devis n’a jamais été chiffré.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Lignes du devis {proposal.number}</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Désignation</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Quantité</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Prix unitaire HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Remise</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
                  {actions.edit && (
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {proposal.lines.map((line) => (
                  <tr key={line.id} className="align-top">
                    <td className="px-4 py-3">
                      <span className="font-medium">{line.label}</span>
                      {line.description && (
                        <span className="block max-w-prose whitespace-pre-line text-xs text-muted-foreground">{line.description}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">{proposalLineSourceLabels[line.source]}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {line.quantity}
                      <span className="block text-xs text-muted-foreground">{rateUnitLabels[line.unit].toLowerCase()}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(line.unitPriceCents, proposal.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {line.discountBp !== null
                        ? formatBasisPoints(line.discountBp)
                        : line.discountAmountCents !== null
                          ? formatCents(line.discountAmountCents, proposal.currency)
                          : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">{formatBasisPoints(line.vatRateBp)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular">
                      {formatCents(line.amountCents ?? lineAmountCents(line), proposal.currency)}
                    </td>
                    {actions.edit && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <Link
                            href={`/devis/${proposal.id}?ligne=${line.id}#ligne-form`}
                            aria-label={`Modifier la ligne ${line.label}`}
                            className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            Modifier
                          </Link>
                          <ProposalActionButton
                            action={removeProposalLineAction}
                            fields={{ proposalId: proposal.id, lineId: line.id }}
                            label="Retirer"
                            ariaLabel={`Retirer la ligne ${line.label}`}
                            pendingLabel="Retrait…"
                            className="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive disabled:opacity-50"
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border">
                <tr>
                  <th scope="row" colSpan={5} className="px-4 py-2 text-right font-medium">
                    Total HT
                  </th>
                  <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular">
                    {formatCents(totals.netCents, proposal.currency)}
                  </td>
                  {actions.edit && <td />}
                </tr>
                {totals.vat.map((group) => (
                  <tr key={group.vatRateBp} className="text-muted-foreground">
                    <th scope="row" colSpan={5} className="px-4 py-1 text-right font-normal">
                      TVA {formatBasisPoints(group.vatRateBp)} sur{' '}
                      <span className="tabular">{formatCents(group.baseCents, proposal.currency)}</span>
                    </th>
                    <td className="whitespace-nowrap px-4 py-1 text-right tabular">
                      {formatCents(group.vatCents, proposal.currency)}
                    </td>
                    {actions.edit && <td />}
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <th scope="row" colSpan={5} className="px-4 py-2 text-right font-semibold">
                    Total TTC
                  </th>
                  <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular">
                    {formatCents(totals.totalCents, proposal.currency)}
                  </td>
                  {actions.edit && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {actions.edit && (
        <section
          id="ligne-form"
          aria-labelledby="ligne-form-titre"
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
        >
          <h2 id="ligne-form-titre" className="text-sm font-semibold tracking-tight">
            {editedLine ? `Modifier la ligne « ${editedLine.label} »` : 'Ajouter une ligne'}
          </h2>
          {/* Remonté après chaque écriture : le formulaire repart vide. */}
          <ProposalLineForm
            key={`${editedLine?.id ?? 'ajout'}-${proposal.lines.length}-${enregistre ?? ''}`}
            proposalId={proposal.id}
            services={services}
            currency={proposal.currency}
            defaultVatRate={basisPointsToInput(tenant.defaultVatRateBp)}
            editing={editedLine ? { lineId: editedLine.id, label: editedLine.label, values: lineToValues(editedLine) } : undefined}
          />
        </section>
      )}
    </div>
  )
}
