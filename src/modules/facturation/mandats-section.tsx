import { todayIsoDate } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { maskIban } from './iban.ts'
import { listClientMandates, mandateEncryptionReady } from './mandats.ts'
import { MandateForm } from './mandate-form.tsx'
import { formatIsoDateFr } from './paiements-regles.ts'
import {
  sepaMandateStatusLabels,
  sepaMandateStatusStyles,
  sepaSequenceTypeLabels,
} from './reglements-labels.ts'
import { RevokeMandateButton } from './revoke-mandate-button.tsx'

/**
 * Mandats de prélèvement SEPA, sur la fiche client (R16, ADR 027, ADR 030).
 *
 * Lecture : `facturation.consulter` ; enregistrement et révocation :
 * `paiements.gerer` (`canManage`). L'IBAN ne s'affiche jamais que masqué.
 */
export async function SepaMandatesSection({
  clientId,
  clientName,
  archived,
  canManage,
}: {
  clientId: string
  clientName: string
  archived: boolean
  canManage: boolean
}) {
  const today = todayIsoDate(await currentTimeZone())
  const mandates = await listClientMandates(clientId, today)
  const active = mandates.find((mandate) => mandate.status === 'active')
  const encryptionReady = canManage ? mandateEncryptionReady() : true

  return (
    <section id="mandats" aria-labelledby="mandats-titre" className="flex flex-col gap-3">
      <h2 id="mandats-titre" className="text-sm font-semibold tracking-tight">
        Mandats de prélèvement SEPA{' '}
        <span className="font-normal text-muted-foreground">({mandates.length})</span>
      </h2>
      <p className="text-sm text-muted-foreground">
        Le mandat signé par le client autorise le centre à prélever ses factures. Un seul est actif à la
        fois ; un changement de compte passe par un nouveau mandat.
      </p>

      {mandates.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table aria-labelledby="mandats-titre" className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Référence (RUM)</th>
                <th scope="col" className="px-4 py-3 font-medium">Titulaire</th>
                <th scope="col" className="px-4 py-3 font-medium">IBAN</th>
                <th scope="col" className="px-4 py-3 font-medium">Signé le</th>
                <th scope="col" className="px-4 py-3 font-medium">Type</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
                {canManage && (
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {mandates.map((mandate) => (
                <tr key={mandate.id}>
                  <td className="whitespace-nowrap px-4 py-3 font-medium tabular">{mandate.reference}</td>
                  <td className="px-4 py-3">{mandate.debtorName}</td>
                  <td className="whitespace-nowrap px-4 py-3 tabular">
                    {maskIban(mandate.ibanLast4)}
                    {mandate.bic && <span className="block text-xs text-muted-foreground">BIC {mandate.bic}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(mandate.signedOn)}</td>
                  <td className="px-4 py-3">{sepaSequenceTypeLabels[mandate.sequenceType]}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${sepaMandateStatusStyles[mandate.lapsed ? 'expired' : mandate.status]}`}
                    >
                      {sepaMandateStatusLabels[mandate.lapsed ? 'expired' : mandate.status]}
                    </span>
                    {mandate.revokedOn && (
                      <span className="block text-xs text-muted-foreground">
                        le {formatIsoDateFr(mandate.revokedOn)}
                      </span>
                    )}
                    {mandate.lapsed && (
                      <span className="block text-xs text-muted-foreground">36 mois sans prélèvement</span>
                    )}
                    {mandate.lastCollectedOn && (
                      <span className="block text-xs text-muted-foreground">
                        Dernier prélèvement : {formatIsoDateFr(mandate.lastCollectedOn)}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      {mandate.status === 'active' && (
                        <RevokeMandateButton clientId={clientId} mandateId={mandate.id} reference={mandate.reference} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && !archived && (
        <div className="rounded-lg border border-border bg-white px-5 py-4">
          {active ? (
            <p className="text-sm text-muted-foreground">
              Le mandat {active.reference} est actif. Pour prélever un autre compte, révoquez-le puis
              enregistrez le nouveau mandat signé.
            </p>
          ) : !encryptionReady ? (
            <p className="text-sm text-foreground">
              Le chiffrement des documents n’est pas configuré sur ce serveur : aucun mandat ne peut être
              enregistré, l’IBAN ne doit jamais être stocké en clair. Prévenez la personne qui administre
              l’application.
            </p>
          ) : (
            <>
              <h3 className="mb-3 text-sm font-semibold">
                {mandates.length === 0 ? 'Enregistrer le mandat signé' : 'Enregistrer un nouveau mandat'}
              </h3>
              <MandateForm clientId={clientId} defaultDebtorName={clientName} today={today} />
            </>
          )}
        </div>
      )}

      {mandates.length === 0 && !canManage && (
        <p className="text-sm text-muted-foreground">
          Aucun mandat : ce client règle par virement. L’exploitant enregistre un mandat quand le client
          en signe un.
        </p>
      )}
    </section>
  )
}
