import Link from 'next/link'

import { ArrowRightIcon, MapPinIcon } from '../../../../components/ui/icons.tsx'
import { withReturn } from '../../../../lib/redirection.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { ProfileForm } from '../../../../modules/clients/mon-compte-form.tsx'
import { loadMemberProfile } from '../../../../modules/clients/mon-compte-queries.ts'
import { PasswordForm } from '../../../../modules/clients/mot-de-passe-form.tsx'
import { loadClientSpace } from '../espace.ts'
import { ParametresNav } from './parametres-nav.tsx'

export const metadata = { title: 'Mon compte' }

/**
 * « Mon compte » (ADR 077) : ce qui concerne la personne connectée — son nom,
 * son téléphone, son adresse, son mot de passe —, séparé des notifications
 * (`/compte/preferences`). Les entreprises dont elle relève sont rappelées :
 * un accès s'ouvre ou se retire par l'accueil.
 *
 * « Mes adresses » (recette du 17/11) : pour une entreprise domiciliée ou qui
 * le demande, un accès direct à son adresse de domiciliation et à son carnet
 * de réexpédition — la page reste celle du courrier (ADR 078), qui ramène ici.
 */
export default async function MonComptePage() {
  const access = await requireClientAccount()
  const { user, accounts } = access
  const [profile, space] = await Promise.all([loadMemberProfile(accounts), loadClientSpace(access)])
  const showAddresses = space.domiciliated || space.domiciliationRequests.length > 0

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

          {showAddresses && (
            <section aria-labelledby="mes-adresses" className="rounded-2xl border border-border bg-white p-4 sm:p-6">
              <h2 id="mes-adresses" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <MapPinIcon size={20} className="text-primary" />
                Mes adresses
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                L’adresse de domiciliation de votre entreprise au centre, et les adresses où le centre peut vous
                réexpédier votre courrier.
              </p>
              <Link
                href={withReturn('/compte/courrier/adresses', '/compte/mon-compte')}
                className="mt-3 inline-flex min-h-11 items-center gap-2 font-medium text-primary underline-offset-2 hover:underline"
              >
                Voir et gérer mes adresses
                <ArrowRightIcon size={20} />
              </Link>
            </section>
          )}

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
