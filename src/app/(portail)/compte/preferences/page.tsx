import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { PreferencesForm } from '../../../../modules/notifications/preferences-form.tsx'
import { listMemberPreferences } from '../../../../modules/notifications/queries.ts'

export const metadata = { title: 'Préférences des messages' }

/**
 * Préférences de messages (R26, ADR 038) : la personne connectée choisit les
 * courriels qu'elle reçoit, entreprise par entreprise. Tout passe par la
 * portée client (ADR 019) : elle ne voit ni ne règle que ses propres accès.
 */
export default async function PreferencesPage() {
  const { accounts } = await requireClientAccount()
  const preferences = await listMemberPreferences(accounts)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Préférences des messages</h1>
        <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
          Choisissez les courriels que vous recevez. Un courriel vous prévient : le document lui-même
          reste dans votre espace, il n’est jamais joint.
        </p>
        <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
          Toujours envoyé : l’ouverture d’un accès à votre espace. Les relances de factures impayées
          sont adressées aux contacts de facturation de l’entreprise, quels que soient ces choix.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {preferences.map(({ account, enabled }) => (
          <PreferencesForm
            key={account.clientId}
            clientId={account.clientId}
            clientName={account.clientName}
            showClientName={accounts.length > 1}
            enabled={enabled}
          />
        ))}
      </div>
    </div>
  )
}
