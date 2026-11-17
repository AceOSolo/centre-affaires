import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { visiblePreferenceGroups } from '../../../../modules/notifications/preferences-groupes.ts'
import { PreferencesForm } from '../../../../modules/notifications/preferences-form.tsx'
import { listMemberPreferences } from '../../../../modules/notifications/queries.ts'
import { loadClientSpace } from '../espace.ts'
import { ParametresNav } from '../mon-compte/parametres-nav.tsx'

export const metadata = { title: 'Mes notifications' }

/**
 * Préférences de messages (R26, ADR 038), rangées par service utilisé
 * (ADR 077) : courrier si l'entreprise est domiciliée, réservations si elle en
 * a, contrats, états des lieux, factures, et les informations du centre pour
 * tous. Les autres groupes ne s'affichent pas et gardent leur réglage.
 *
 * Tout passe par la portée client (ADR 019) : la personne ne voit ni ne règle
 * que ses propres accès. Les groupes valent pour l'ensemble des entreprises
 * du compte (choix par défaut de l'ADR 077, à confirmer en recette).
 */
export default async function PreferencesPage() {
  const compte = await requireClientAccount()
  const [preferences, space] = await Promise.all([listMemberPreferences(compte.accounts), loadClientSpace(compte)])
  const groups = visiblePreferenceGroups(space.usage)
  const onlyCentre = groups.length === 1

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Mon compte</h1>
        <div className="mt-4">
          <ParametresNav actif="notifications" />
        </div>
      </div>
      <div className="max-w-[65ch]">
        <h2 className="text-lg font-semibold tracking-tight">Notifications par courriel</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Choisissez, service par service, ce que nous vous envoyons par courriel. Un courriel vous prévient : le
          document lui-même reste dans votre espace, il n’est jamais joint. La cloche de votre espace annonce les
          nouveautés quels que soient ces choix.
        </p>
        {onlyCentre && (
          <p className="mt-2 text-sm text-muted-foreground">
            D’autres choix apparaîtront ici dès que vous utiliserez nos services : courrier, réservations, contrats.
            D’ici là, vous recevez tous nos messages.
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Toujours envoyé : l’ouverture d’un accès à votre espace. Les relances de factures impayées sont adressées
          aux contacts de facturation de l’entreprise, quels que soient ces choix.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {preferences.map(({ account, enabled }) => (
          <PreferencesForm
            key={account.clientId}
            clientId={account.clientId}
            clientName={account.clientName}
            showClientName={compte.accounts.length > 1}
            groups={groups}
            enabled={enabled}
          />
        ))}
      </div>
    </div>
  )
}
