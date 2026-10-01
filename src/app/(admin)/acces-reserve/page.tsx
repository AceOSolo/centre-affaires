import Link from 'next/link'

import { staffRoleLabels } from '../../../db/staff.ts'
import {
  isPermission,
  permissionLabels,
  rolesAllowed,
} from '../../../lib/auth/permissions.ts'
import { requireStaff } from '../../../lib/auth/staff.ts'

export const metadata = { title: 'Accès réservé' }

/**
 * Où `requirePermission()` renvoie un membre de l'équipe dont le rôle ne
 * permet pas la page ou l'action demandée (ADR 019).
 *
 * Seule page du back-office gardée par `requireStaff()` seul : elle doit
 * s'afficher à tout membre, puisque c'est elle qui explique le refus. Elle
 * dit ce qui était demandé et à qui s'adresser — la matrice des droits n'est
 * pas un secret pour l'équipe.
 */
export default async function AccesReservePage({
  searchParams,
}: {
  searchParams: Promise<{ droit?: string }>
}) {
  const { member } = await requireStaff()
  const { droit } = await searchParams
  const permission = isPermission(droit) ? droit : undefined
  const roles = permission ? rolesAllowed(permission) : []

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Accès réservé</h1>
      <div className="rounded-lg border border-border bg-white px-5 py-4 text-sm">
        {permission ? (
          <p>
            Cette page ou cette action relève du droit «&nbsp;{permissionLabels[permission]}&nbsp;»,
            réservé {roles.length > 1 ? 'aux rôles' : 'au rôle'} {roles.join(', ')}.
          </p>
        ) : (
          <p>Cette page ou cette action n’est pas ouverte à votre rôle.</p>
        )}
        <p className="mt-2 text-muted-foreground">
          Votre rôle : {staffRoleLabels[member.role]}. Si vous en avez besoin, demandez à un
          exploitant du centre de s’en charger ou de changer votre rôle depuis l’écran Équipe.
        </p>
      </div>
      <div>
        <Link
          href="/reservations"
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Revenir au planning
        </Link>
      </div>
    </div>
  )
}
