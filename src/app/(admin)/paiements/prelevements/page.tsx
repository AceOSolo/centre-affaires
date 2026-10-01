import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { addDaysToIsoDate, formatDateTime, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { checkCollectionDate, isRemittanceId } from '../../../../modules/facturation/mandats-regles.ts'
import { formatIsoDateFr } from '../../../../modules/facturation/paiements-regles.ts'
import { listDirectDebitCandidates, listRemittances } from '../../../../modules/facturation/prelevements.ts'
import { RemittanceForm } from '../../../../modules/facturation/remittance-form.tsx'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Prélèvements SEPA' }

const fieldClass =
  'mt-1 rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Remises de prélèvements SEPA (R16, ADR 027, ADR 028) : les factures émises
 * payables par prélèvement et échues au jour choisi, la préparation de la
 * remise, puis le fichier `pain.008` à déposer à la banque. Sans prestataire :
 * le centre dépose lui-même le fichier.
 */
export default async function DirectDebitPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; remise?: string }>
}) {
  await requirePermission('paiements.gerer')
  const [{ date, remise }, tenant] = await Promise.all([searchParams, currentTenant()])
  const today = todayIsoDate(tenant.timezone)
  // Par défaut, dans deux jours : le fichier part la veille au plus tard.
  const requested = typeof date === 'string' ? date : addDaysToIsoDate(today, 2)
  const dateError = checkCollectionDate(requested, today)
  const collectionDate = dateError ? addDaysToIsoDate(today, 2) : requested
  const [candidates, remittances] = await Promise.all([
    listDirectDebitCandidates({ collectionDate, today }),
    listRemittances(),
  ])
  const prepared =
    typeof remise === 'string' && isRemittanceId(remise)
      ? remittances.find((row) => row.remittanceId === remise)
      : undefined
  const creditorMissing = [
    tenant.sepaCreditorId ? null : 'l’identifiant créancier SEPA (ICS)',
    tenant.bankIban ? null : 'l’IBAN du centre',
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/paiements" className="text-sm text-muted-foreground hover:underline">
          ← Règlements
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Prélèvements SEPA</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Préparez la remise des factures payables par prélèvement et arrivées à échéance, puis déposez
          le fichier à votre banque (format SEPA pain.008, prélèvement CORE). Les factures remises passent
          « réglées » ; un rejet de la banque s’annule depuis leur fiche de règlement.
        </p>
      </div>

      {prepared && (
        <FlashNotice key={prepared.remittanceId}>
          <p>
            Remise <span className="font-medium tabular">{prepared.remittanceId}</span> préparée :{' '}
            {prepared.activeCount} prélèvement{prepared.activeCount > 1 ? 's' : ''},{' '}
            {formatCents(prepared.activeTotalCents)}, à prélever le {formatIsoDateFr(prepared.collectionDate)}.
          </p>
          <p className="mt-1">
            <a
              href={`/paiements/prelevements/${prepared.remittanceId}`}
              className="font-medium text-primary underline underline-offset-2"
            >
              Télécharger le fichier à déposer à la banque
            </a>{' '}
            — avant le {formatIsoDateFr(addDaysToIsoDate(prepared.collectionDate, -1))}.
          </p>
        </FlashNotice>
      )}

      {creditorMissing.length > 0 && (
        <p className="rounded-lg border border-border bg-white px-5 py-4 text-sm text-foreground">
          Aucun fichier ne peut être produit : renseignez {creditorMissing.join(' et ')} dans l’identité de
          facturation du centre (droit « Configuration du centre »).
        </p>
      )}

      <section aria-labelledby="a-prelever-titre" className="flex flex-col gap-3">
        <h2 id="a-prelever-titre" className="text-sm font-semibold tracking-tight">
          Factures à prélever <span className="font-normal text-muted-foreground">({candidates.length})</span>
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="date" className="block text-sm font-medium text-foreground">
              Date de prélèvement
            </label>
            <input
              id="date"
              name="date"
              type="date"
              min={addDaysToIsoDate(today, 1)}
              defaultValue={collectionDate}
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? 'date-error date-hint' : 'date-hint'}
              className={fieldClass}
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Afficher
          </button>
          <p id="date-hint" className="w-full text-xs text-muted-foreground">
            Les factures échues à cette date. La banque reçoit le fichier au plus tard la veille.
          </p>
          {dateError && (
            <p id="date-error" role="alert" className="w-full text-xs text-destructive">
              {dateError} La liste montre le {formatIsoDateFr(collectionDate)}.
            </p>
          )}
        </form>
        <RemittanceForm
          // Une autre date est une autre sélection : le formulaire repart de zéro.
          key={`${collectionDate}-${prepared?.remittanceId ?? ''}`}
          collectionDate={collectionDate}
          rows={candidates.map((candidate) => ({
            invoiceId: candidate.invoiceId,
            number: candidate.number,
            clientName: candidate.clientName,
            dueDate: candidate.dueDate,
            amountDueCents: candidate.amountDueCents,
            currency: candidate.currency,
            mandateReference: candidate.mandate?.reference ?? null,
            ibanLast4: candidate.mandate?.ibanLast4 ?? null,
            blocker: candidate.blocker,
          }))}
        />
      </section>

      <section aria-labelledby="remises-titre" className="flex flex-col gap-3">
        <h2 id="remises-titre" className="text-sm font-semibold tracking-tight">
          Remises préparées
        </h2>
        {remittances.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune remise pour l’instant : cochez les factures ci-dessus et préparez la première.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table aria-labelledby="remises-titre" className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Remise</th>
                  <th scope="col" className="px-4 py-3 font-medium">Préparée le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Prélèvement le</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Prélèvements</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Fichier</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {remittances.map((row) => (
                  <tr key={row.remittanceId}>
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular">{row.remittanceId}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatDateTime(row.createdAt, tenant.timezone)}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(row.collectionDate)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {row.activeCount}
                      {row.cancelledCount > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {row.cancelledCount} rejeté{row.cancelledCount > 1 ? 's' : ''} ou annulé{row.cancelledCount > 1 ? 's' : ''}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">{formatCents(row.activeTotalCents)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {row.activeCount > 0 ? (
                        <a
                          href={`/paiements/prelevements/${row.remittanceId}`}
                          aria-label={`Télécharger le fichier de la remise ${row.remittanceId}`}
                          className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Fichier XML
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">Entièrement annulée</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
