import Link from 'next/link'

import type { Tenant } from '../../db/tenants.ts'
import { EmailPreview } from './apercu-courriel.tsx'
import { notificationEventLabels } from './catalogue.ts'
import { automaticSignatureLines, emailIdentityValues, logoOf } from './identite.ts'
import { EmailIdentityForm } from './identite-form.tsx'
import { brandingFromIdentity, publicAddress, siteOrigins } from './identite-queries.ts'
import { EmailLogoForm } from './logo-form.tsx'
import { listTemplateStates } from './queries.ts'
import { EXAMPLE_ORIGIN } from './rendu.ts'
import { notificationEvents, type NotificationEvent } from './schema.ts'

/** Les messages les plus lus d'abord dans le choix de l'aperçu (recette du 17/11). */
const FIRST: readonly NotificationEvent[] = ['request_received', 'mail_batch_received', 'mail_scanned', 'member_invited']

const linkClass =
  'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Section « Courriels : logo et signature » de Configuration (ADR 080) : ce qui
 * habille tous les courriels du centre, et leur aperçu. Réservée, comme la
 * page, à qui configure le centre (`centre.configurer`).
 */
export async function EmailIdentitySection({ tenant, address }: { tenant: Tenant; address: string }) {
  const [branding, templates] = await Promise.all([
    // Le logo en adresse relative : l'écran le montre même sans `APP_URL` en HTTPS.
    brandingFromIdentity(tenant, { relativeLogo: true }),
    listTemplateStates(notificationEvents),
  ])
  const origins = siteOrigins()
  const logo = logoOf(tenant)
  const logoInEmails = logo.path !== null && publicAddress(logo.path) !== null
  const choices = [...FIRST, ...notificationEvents.filter((event) => !FIRST.includes(event))].map((event) => ({
    value: event,
    label: notificationEventLabels[event],
  }))

  return (
    <section
      id="identite-courriels"
      aria-labelledby="identite-courriels-title"
      className="scroll-mt-6 rounded-lg border border-border bg-white px-5 py-4"
    >
      <h2 id="identite-courriels-title" className="text-base font-semibold tracking-tight">
        Courriels : logo et signature
      </h2>
      <div className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
        <p>
          Tous les courriels du centre partent dans la même mise en page : le logo en tête, le texte du
          modèle, un bouton pour chaque lien vers le site, puis la signature. Les textes se règlent dans les{' '}
          <Link href="/notifications/modeles" className={linkClass}>
            modèles des messages
          </Link>
          ; l’adresse dans « Identité légale du vendeur », l’adresse e-mail plus haut.
        </p>
        <p className="mt-1 text-xs">
          Les champs marqués <span aria-hidden="true">*</span>
          <span className="sr-only">d’un astérisque</span> sont obligatoires.
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Nom et signature</h3>
          <EmailIdentityForm values={emailIdentityValues(tenant)} automaticLines={automaticSignatureLines(tenant)} />
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Logo</h3>
          <EmailLogoForm
            source={logo.source}
            src={branding.logo?.url ?? null}
            width={branding.logo?.width ?? null}
            height={branding.logo?.height ?? null}
            centreName={tenant.name}
          />
          {logo.path !== null && !logoInEmails && (
            <p className="max-w-prose rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
              Pour l’instant, les courriels partent sans logo, avec le nom du centre en tête : l’adresse
              publique du site (variable APP_URL du serveur) n’est pas une adresse en https. L’aperçu montre le
              logo tel qu’il apparaîtra une fois cette adresse posée.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Aperçu</h3>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            Rempli avec des valeurs d’exemple fictives, avec le logo et la signature enregistrés. L’essai part à
            votre adresse seulement.
            {origins.length === 0 &&
              ' L’adresse publique du site (APP_URL) n’est pas posée : les vrais courriels partent sans liens ni boutons.'}
          </p>
          <EmailPreview
            branding={{ ...branding, linkOrigins: origins.length > 0 ? origins : [EXAMPLE_ORIGIN] }}
            templates={Object.fromEntries(
              templates.map((state) => [state.event, { subject: state.subject, body: state.body, active: state.active }]),
            )}
            choices={choices}
            origin={origins[0] ?? EXAMPLE_ORIGIN}
            address={address}
            defaultEvent="request_received"
          />
        </div>
      </div>
    </section>
  )
}
