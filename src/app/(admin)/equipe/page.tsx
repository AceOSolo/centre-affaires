import { CheckIcon } from '../../../components/ui/icons.tsx'
import { staffRoleLabels, staffRoles, type StaffRole } from '../../../db/staff.ts'
import { findTeamMember, listTeamMembers } from '../../../lib/auth/equipe.ts'
import { can, permissionLabels, permissions } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { TeamMemberForm } from './team-member-form.tsx'
import { TeamRowActions } from './team-row-actions.tsx'

export const metadata = { title: 'Équipe' }

const otherRole: Record<StaffRole, StaffRole> = { admin: 'staff', staff: 'admin' }

/**
 * L'équipe du centre (R27, ADR 019) : qui entre dans le back-office, avec quel
 * rôle. Réservé à l'exploitant.
 *
 * Remplace l'usage courant de `infra/ajouter-membre-staff.mjs`, gardé pour
 * l'amorçage : le premier exploitant ne peut pas s'inscrire lui-même.
 */
export default async function EquipePage({
  searchParams,
}: {
  searchParams: Promise<{ retire?: string }>
}) {
  const { member: me } = await requirePermission('equipe.gerer')
  const { retire } = await searchParams
  const [team, removed] = await Promise.all([
    listTeamMembers(),
    retire ? findTeamMember(retire) : undefined,
  ])
  const adminCount = team.filter((member) => member.role === 'admin').length
  const roles = staffRoles.map((role) => ({ value: role, label: staffRoleLabels[role] }))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Équipe</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Les personnes qui ont accès au back-office et leur rôle. L’accueil tient le quotidien —
          planning, demandes, courrier, fiches clients ; l’exploitant fait tout, dont les tarifs,
          les contrats, l’équipe et la configuration du centre.
        </p>
      </div>

      {removed?.deletedAt && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
        >
          <CheckIcon size={20} />
          {removed.fullName ?? removed.email} n’a plus accès au back-office. Son passage reste dans
          l’historique.
        </p>
      )}

      <section aria-labelledby="membres" className="flex flex-col gap-3">
        <h2 id="membres" className="text-sm font-semibold tracking-tight">
          Membres <span className="font-normal text-muted-foreground">({team.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Nom</th>
                <th className="px-4 py-3 font-medium">Adresse</th>
                <th className="px-4 py-3 font-medium">Rôle</th>
                <th className="px-4 py-3 font-medium">Accès</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {team.map((member) => {
                const self = member.id === me.id
                const lastAdmin = member.role === 'admin' && adminCount <= 1
                const next = otherRole[member.role]
                return (
                  <tr key={member.id}>
                    <td className="px-4 py-3">
                      {member.fullName ?? '—'}
                      {self && <span className="ml-2 text-xs text-muted-foreground">(vous)</span>}
                    </td>
                    <td className="px-4 py-3">{member.email}</td>
                    <td className="px-4 py-3">
                      {/* Libellé et couleur : le rôle ne se lit pas qu'à la teinte. */}
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          member.role === 'admin'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-accent/15 text-primary'
                        }`}
                      >
                        {staffRoleLabels[member.role]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.authUserId ? 'Compte activé' : 'En attente de première connexion'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {self ? (
                        <span className="text-xs text-muted-foreground">
                          Votre compte : un autre exploitant le gère.
                        </span>
                      ) : lastAdmin ? (
                        <span className="text-xs text-muted-foreground">
                          Dernier exploitant : nommez-en un autre avant de le changer.
                        </span>
                      ) : (
                        <TeamRowActions
                          memberId={member.id}
                          name={member.fullName ?? member.email}
                          nextRole={{ value: next, label: staffRoleLabels[next] }}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="inscrire" className="flex flex-col gap-3">
        <h2 id="inscrire" className="text-sm font-semibold tracking-tight">
          Inscrire un membre
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          La personne crée ensuite son accès sur la page de connexion, avec cette adresse : son
          compte lui est rattaché à la première connexion.
        </p>
        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <TeamMemberForm roles={roles} />
        </div>
      </section>

      <section aria-labelledby="droits" className="flex flex-col gap-3">
        <h2 id="droits" className="text-sm font-semibold tracking-tight">
          Ce que chaque rôle permet
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Droit</th>
                {staffRoles.map((role) => (
                  <th key={role} className="px-4 py-3 font-medium">
                    {staffRoleLabels[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {permissions.map((permission) => (
                <tr key={permission}>
                  <td className="px-4 py-2">{permissionLabels[permission]}</td>
                  {staffRoles.map((role) => (
                    <td key={role} className="px-4 py-2">
                      {can(role, permission) ? (
                        <span className="inline-flex items-center gap-1 text-primary">
                          <CheckIcon size={16} />
                          Oui
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Non</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
