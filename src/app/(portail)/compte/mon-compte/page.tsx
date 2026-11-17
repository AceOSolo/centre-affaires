import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { ProfileForm } from '../../../../modules/clients/mon-compte-form.tsx'
import { loadMemberProfile } from '../../../../modules/clients/mon-compte-queries.ts'
import { PasswordForm } from '../../../../modules/clients/mot-de-passe-form.tsx'
import { ParametresNav } from './parametres-nav.tsx'

export const metadata = { title: 'Mon compte' }

/**
 * « Mon compte » (ADR 077) : ce qui concerne la personne connectée — son nom,
 * son téléphone, son adresse, son mot de passe —, séparé des notifications
 * (`/compte/preferences`). Les entreprises dont elle relève sont rappelées :
 * un accès s'ouvre ou se retire par l'accueil.
 */
export default async function MonComptePage() {
  const { user, accounts } = await requireClientAccount()
  const profile = await loadMemberProfile(accounts)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Mon compte</h1>
        <div className="mt-4">
          <ParametresNav actif="compte" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="mes-informations" className="rounded-2xl border border-border bg-white p-4 sm:p-6">
          <h2 id="mes-informations" className="text-lg font-semibold tracking-tight">
            Mes informations
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            L’équipe du centre les voit sur la fiche de votre entreprise, pour vous joindre.
          </p>
          <div className="mt-4">
            <ProfileForm
              email={user.email}
              initial={{ fullName: profile.fullName ?? user.name ?? '', phone: profile.phone ?? '' }}
            />
          </div>
        </section>

        <div className="flex flex-col gap-6">
          <section aria-labelledby="mot-de-passe" className="rounded-2xl border border-border bg-white p-4 sm:p-6">
            <h2 id="mot-de-passe" className="text-lg font-semibold tracking-tight">
              Mot de passe
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Mot de passe actuel oublié ? Déconnectez-vous, puis choisissez « Mot de passe oublié ? » sur la page de
              connexion.
            </p>
            <div className="mt-4">
              <PasswordForm />
            </div>
          </section>

          <section aria-labelledby="mes-entreprises" className="rounded-2xl border border-border bg-white p-4 sm:p-6">
            <h2 id="mes-entreprises" className="text-lg font-semibold tracking-tight">
              {accounts.length > 1 ? 'Mes entreprises' : 'Mon entreprise'}
            </h2>
            <ul className="mt-3 flex flex-col gap-1 text-base">
              {accounts.map((account) => (
                <li key={account.clientId} className="font-medium text-foreground">
                  {account.clientName}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Pour accéder à l’espace d’une autre entreprise, ou ouvrir l’accès à un collègue, adressez-vous à l’accueil
              du centre.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
