import Link from 'next/link'

import type { Tenant } from '../../db/tenants.ts'
import { findAnonymizationOutlook } from './anonymisation.ts'
import { RetentionDurationsForm } from './durees-form.tsx'
import { retentionValues } from './durees.ts'

/**
 * Section « Durées de conservation » de la configuration du centre (R29,
 * ADR 040) : les neuf durées, et ce que la prochaine tâche de nuit en fera.
 * Réservée, comme la page, à `centre.configurer`.
 */
export async function RetentionSettingsSection({ tenant }: { tenant: Tenant }) {
  const outlook = await findAnonymizationOutlook()

  return (
    <section
      id="conservation"
      aria-labelledby="conservation-title"
      className="rounded-lg border border-border bg-white px-5 py-4"
    >
      <h2 id="conservation-title" className="text-base font-semibold tracking-tight">
        Durées de conservation
      </h2>
      <div className="mt-1 flex max-w-[70ch] flex-col gap-2 text-sm text-muted-foreground">
        <p>
          Au terme de chaque durée, la tâche de nuit efface le document ou anonymise les champs
          personnels ; les lignes restent (rien n’est supprimé). Les factures émises, leurs lignes,
          les paiements et les états des lieux ne sont jamais anonymisés : ils se gardent 10 ans.
        </p>
        <p>
          Une entreprise n’est jamais anonymisée tant qu’elle a une facture non soldée ou un
          brouillon de facture, un contrat vivant, une réservation à venir, un service souscrit en
          cours, un mandat de prélèvement actif, une demande de courrier en cours ou un état des
          lieux en saisie. Une durée validée se reporte au contrat et dans l’information des
          personnes.
        </p>
      </div>

      <div className="mt-4 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Prochaine tâche de nuit, avec les durées enregistrées</p>
        <ul className="mt-1 list-disc pl-5">
          <li>
            <span className="tabular">{outlook.clients}</span>{' '}
            {outlook.clients > 1 ? 'entreprises anonymisées' : 'entreprise anonymisée'}
          </li>
          <li>
            <span className="tabular">{outlook.members}</span>{' '}
            {outlook.members > 1
              ? 'accès ou membres retirés anonymisés'
              : 'accès ou membre retiré anonymisé'}
          </li>
          <li>
            <span className="tabular">{outlook.held}</span>{' '}
            {outlook.held > 1
              ? 'entreprises au terme de leur durée, retenues par une exclusion'
              : 'entreprise au terme de sa durée, retenue par une exclusion'}
          </li>
        </ul>
        {outlook.heldClients.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-primary">
              Voir les entreprises retenues
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {outlook.heldClients.map((client) => (
                <li key={client.id}>
                  <Link
                    href={`/clients/${client.id}#conservation`}
                    className="font-medium underline underline-offset-2"
                  >
                    {client.name}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{client.blockers.join(' ')}</span>
                </li>
              ))}
            </ul>
            {outlook.held > outlook.heldClients.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Les {outlook.heldClients.length} premières sur {outlook.held}.
              </p>
            )}
          </details>
        )}
      </div>

      <RetentionDurationsForm values={retentionValues(tenant)} />
    </section>
  )
}
