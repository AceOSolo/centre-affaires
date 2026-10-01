import { CheckIcon } from '../../components/ui/icons.tsx'
import { checkEn16931, en16931Summary, toEn16931 } from './en16931.ts'
import type { InvoiceSettlement } from './reglements.ts'

/**
 * Préparation de la facturation électronique (R16, ADR 026, ADR 030) : la
 * facture émise décrite en termes EN 16931 et le contrôle de ce que la
 * plateforme agréée exigera. Aucun envoi d'ici : le raccordement viendra.
 * Conçu pour la fiche facture.
 */
export function EInvoicingSection({ settlement }: { settlement: InvoiceSettlement }) {
  const { invoice } = settlement

  if (invoice.status === 'draft') {
    return (
      <section aria-labelledby="einvoicing-titre" className="flex flex-col gap-3">
        <h2 id="einvoicing-titre" className="text-lg font-semibold tracking-tight">
          Facturation électronique
        </h2>
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          La représentation EN 16931 se produit à l’émission : le numéro, la date et les mentions
          figées en font partie.
        </p>
      </section>
    )
  }

  const doc = toEn16931({
    invoice,
    lines: settlement.lines,
    precedingInvoice: settlement.precedingInvoice,
  })
  const checks = checkEn16931(doc)
  const { complete, failures } = en16931Summary(checks)
  const failing = checks.filter((check) => !check.ok)
  const totals = doc['BG-22']

  return (
    <section aria-labelledby="einvoicing-titre" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="einvoicing-titre" className="text-lg font-semibold tracking-tight">
          Facturation électronique
        </h2>
        <a
          href={`/paiements/factures/${invoice.id}/en16931`}
          className="text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          Télécharger la représentation EN 16931 (JSON)
        </a>
      </div>
      <p className="text-sm text-muted-foreground">
        Les données que la plateforme agréée recevra, contrôlées selon la norme EN 16931 et la réforme
        française. Rien n’est envoyé : le raccordement viendra avant l’obligation d’émission du
        1er septembre 2027.
      </p>

      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-border bg-white px-5 py-4 text-sm"
      >
        {complete ? (
          <>
            <CheckIcon size={20} className="shrink-0 text-primary" />
            <p>
              <span className="font-medium">Données complètes</span> : les {checks.length} contrôles sont
              conformes.
            </p>
          </>
        ) : (
          <div>
            <p className="font-medium">
              {failures} contrôle{failures > 1 ? 's' : ''} à reprendre sur {checks.length}
            </p>
            <ul className="mt-2 list-disc pl-5">
              {failing.map((check) => (
                <li key={`${check.term}-${check.label}`}>
                  <span className="tabular text-muted-foreground">{check.term}</span> — {check.label}
                  {check.detail && <span className="block text-xs text-muted-foreground">{check.detail}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Une facture émise ne se modifie plus : complétez la fiche du centre ou du client pour les
              prochaines, et corrigez celle-ci par un avoir si la plateforme la refuse.
            </p>
          </div>
        )}
      </div>

      <details className="rounded-lg border border-border bg-white px-5 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-primary">Termes principaux</summary>
        <dl className="mt-3 grid grid-cols-[minmax(12rem,auto)_1fr] gap-x-6 gap-y-1">
          <Term code="BT-1" label="Numéro" value={doc['BT-1']} />
          <Term code="BT-2" label="Date d’émission" value={doc['BT-2']} />
          <Term code="BT-3" label="Type" value={doc['BT-3'] === '381' ? '381 — avoir' : '380 — facture'} />
          <Term code="BT-5" label="Devise" value={doc['BT-5']} />
          <Term code="BT-9" label="Échéance" value={doc['BT-9']} />
          <Term code="BT-27" label="Vendeur" value={doc['BG-4']['BT-27']} />
          <Term code="BT-30" label="SIREN du vendeur" value={doc['BG-4']['BT-30']?.value ?? null} />
          <Term code="BT-44" label="Acheteur" value={doc['BG-7']['BT-44']} />
          <Term code="BT-47" label="SIREN de l’acheteur" value={doc['BG-7']['BT-47']?.value ?? null} />
          <Term code="BT-81" label="Moyen de paiement" value={`${doc['BG-16']['BT-81']} — ${doc['BG-16']['BT-82']}`} />
          <Term code="BT-109" label="Total HT" value={totals['BT-109']} />
          <Term code="BT-110" label="Total TVA" value={totals['BT-110']} />
          <Term code="BT-112" label="Total TTC" value={totals['BT-112']} />
          <Term code="BT-115" label="Net à payer" value={totals['BT-115']} />
        </dl>
      </details>

      <details className="rounded-lg border border-border bg-white px-5 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-primary">Tous les contrôles ({checks.length})</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Terme</th>
                <th scope="col" className="py-2 pr-4 font-medium">Contrôle</th>
                <th scope="col" className="py-2 font-medium">Résultat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {checks.map((check) => (
                <tr key={`${check.term}-${check.label}`}>
                  <td className="whitespace-nowrap py-2 pr-4 tabular text-muted-foreground">{check.term}</td>
                  <td className="py-2 pr-4">{check.label}</td>
                  <td className="py-2">
                    {/* Le résultat se lit au mot, pas à la teinte. */}
                    {check.ok ? (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <CheckIcon size={16} /> Conforme
                      </span>
                    ) : (
                      <span className="font-medium text-foreground">À reprendre</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

function Term({ code, label, value }: { code: string; label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">
        <span className="tabular">{code}</span> {label}
      </dt>
      <dd className="tabular">{value ?? '—'}</dd>
    </>
  )
}
