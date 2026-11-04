import Link from 'next/link'

import { ArrowLeftIcon } from '../../../../components/ui/icons.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { crmConnectors } from '../../../../modules/crm/catalogue.ts'
import { crmConnectorIds } from '../../../../modules/crm/connecteurs.ts'
import {
  ClearCrmKeyForm,
  CrmFlowsForm,
  CrmSettingsForm,
  CrmTestForm,
  CrmTokenPanel,
  type CrmFlowOption,
} from '../../../../modules/crm/connexion-crm-forms.tsx'
import { crmFlowDefinitions, crmFlowDirectionLabels, crmFlows } from '../../../../modules/crm/flux.ts'
import { CrmExchangesTable } from '../../../../modules/crm/journal-echanges.tsx'
import { crmConnectionView, listCrmExchanges } from '../../../../modules/crm/queries.ts'

export const metadata = { title: 'Connexion au CRM' }

/**
 * « Connexion au CRM » (ADR 065) : le CRM du centre, le jeton qu'il présente
 * au site, la clé pour l'appeler, les flux échangés, le test et le journal.
 * Réglé par centre, réservé à la direction (`crm.gerer`, ADR 054) : le jeton
 * ouvre au CRM les devis et les prix du centre.
 */
export default async function ConnexionCrmPage() {
  await requirePermission('crm.gerer')
  const [view, exchanges, timeZone] = await Promise.all([
    crmConnectionView(),
    listCrmExchanges(30),
    currentTimeZone(),
  ])
  const connector = crmConnectors[view.connector]
  const serverTokenSet = Boolean(connector.legacyTokenEnv && process.env[connector.legacyTokenEnv])

  const flows: CrmFlowOption[] = crmFlows.map((flow) => ({
    id: flow,
    label: crmFlowDefinitions[flow].label,
    description: crmFlowDefinitions[flow].description,
    direction: crmFlowDirectionLabels[crmFlowDefinitions[flow].direction],
    routes: connector.routes[flow] ?? [],
    available: connector.flows.includes(flow),
    enabled: view.enabledFlows.includes(flow),
  }))

  const section = 'flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4'

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/reglages"
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon size={20} />
          Réglages
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Connexion au CRM</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Le CRM du centre tient les tiers, les devis, les contrats et la facturation. Le site lui
          transmet ce qu’il recueille et reçoit ce dont l’accueil a besoin. Ces réglages valent pour ce
          centre seulement ; le format des échanges est décrit pour le développeur du CRM dans la
          notice du dépôt ({connector.notice}).
        </p>
      </div>

      <section aria-labelledby="crm-choix" className={section}>
        <div>
          <h2 id="crm-choix" className="text-lg font-semibold tracking-tight">
            Le CRM
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Aujourd’hui, le CRM appelle le site ; le site ne l’appelle pas. L’adresse et la clé servent au
            test de connexion et aux envois à venir.
          </p>
        </div>
        <CrmSettingsForm
          connectors={crmConnectorIds.map((id) => ({ value: id, label: crmConnectors[id].label }))}
          connector={view.connector}
          baseUrl={view.baseUrl ?? ''}
          keyStatus={
            view.hasKey && view.keySetAt
              ? `Clé enregistrée le ${formatDateTime(view.keySetAt, timeZone)}, chiffrée, jamais réaffichée.`
              : 'Aucune clé enregistrée.'
          }
          keyLabel={connector.outbound.keyLabel}
          keyHelp={connector.outbound.keyHelp}
          urlHelp={connector.outbound.urlHelp}
          urlExample={connector.outbound.urlExample}
        />
        {view.hasKey && <ClearCrmKeyForm />}
      </section>

      <section aria-labelledby="crm-jeton" className={section}>
        <div>
          <h2 id="crm-jeton" className="text-lg font-semibold tracking-tight">
            Jeton d’accès du CRM
          </h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            {view.hasToken && view.tokenSetAt ? (
              <>
                Jeton réglé ici le {formatDateTime(view.tokenSetAt, timeZone)}
                {view.tokenSetBy ? ` par ${view.tokenSetBy}` : ''}. Il désigne ce centre : un appel qui le
                présente est servi pour lui seul.
                {connector.legacyTokenEnv &&
                  ` Le jeton du serveur (${connector.legacyTokenEnv}) n’est plus accepté.`}
              </>
            ) : serverTokenSet && connector.legacyTokenEnv ? (
              <>
                {connector.label} s’identifie aujourd’hui avec le jeton posé sur le serveur (
                {connector.legacyTokenEnv}). Générer un jeton ici le remplace aussitôt : remettez le
                nouveau au développeur du CRM avant, ou juste après.
              </>
            ) : (
              <>
                Aucun jeton : {connector.label} ne peut pas appeler le site. Générez-en un et remettez-le au
                développeur du CRM. Il n’est affiché qu’une fois.
              </>
            )}
          </p>
        </div>
        <CrmTokenPanel
          hasToken={view.hasToken}
          serverToken={serverTokenSet ? connector.legacyTokenEnv : undefined}
          appUrl={process.env.APP_URL ?? ''}
          productsRoute={connector.routes.products?.[0]?.replace(/^POST /, '')}
        />
      </section>

      <section aria-labelledby="crm-flux" className={section}>
        <div>
          <h2 id="crm-flux" className="text-lg font-semibold tracking-tight">
            Flux échangés
          </h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            Un flux coupé est refusé au CRM, avec un message qui dit où le rouvrir. Les flux « à venir »
            s’ouvriront quand le site saura les servir.
          </p>
        </div>
        <CrmFlowsForm flows={flows} />
      </section>

      <section aria-labelledby="crm-test" className={section}>
        <div>
          <h2 id="crm-test" className="text-lg font-semibold tracking-tight">
            Tester la connexion
          </h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            Vérifie le jeton qui ouvre le site au CRM, le dernier appel reçu et, si l’adresse et la clé
            sont réglées, un appel du site vers le CRM qui ne lit ni n’écrit aucune donnée.
          </p>
        </div>
        <CrmTestForm />
      </section>

      <section aria-labelledby="crm-journal" className="flex flex-col gap-3">
        <h2 id="crm-journal" className="text-lg font-semibold tracking-tight">
          Journal des échanges
        </h2>
        <CrmExchangesTable exchanges={exchanges} timeZone={timeZone} crmLabel={connector.label} />
      </section>
    </div>
  )
}
