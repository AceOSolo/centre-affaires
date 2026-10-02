import { CheckIcon } from '../../components/ui/icons.tsx'
import { anonymizeStaffMemberAction } from './actions.ts'
import { listRemovedStaffMembers } from './anonymisation.ts'
import { RemovedPeopleTable } from './removed-people.tsx'

/**
 * Membres retirés de l'équipe (R29, ADR 040), sur l'écran « Équipe » : leur
 * ligne signe des plis, des numérisations, des factures ; leur nom et leur
 * adresse partent au terme de la durée du centre, ou plus tôt à leur demande.
 */
export async function RemovedStaffSection({
  canAnonymize,
  timeZone,
  anonymized,
}: {
  /** Droit `rgpd.anonymiser`. */
  canAnonymize: boolean
  timeZone: string
  /** Retour d'une anonymisation à la demande. */
  anonymized?: boolean
}) {
  const removed = await listRemovedStaffMembers()
  if (removed.length === 0 && !anonymized) return null

  return (
    <section id="retires" aria-labelledby="retires-titre" className="flex flex-col gap-3">
      <h2 id="retires-titre" className="text-sm font-semibold tracking-tight">
        Membres retirés
      </h2>
      {anonymized && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
        >
          <CheckIcon size={20} />
          Membre anonymisé : son nom et son adresse sont effacés.
        </p>
      )}
      <p className="max-w-3xl text-sm text-muted-foreground">
        Leur ligne reste : elle signe les plis, les numérisations et les factures qu’ils ont
        enregistrés. Leur nom et leur adresse sont effacés au terme de la durée de conservation
        réglée dans la configuration du centre, ou plus tôt à leur demande.
      </p>
      <RemovedPeopleTable
        id="retires-liste"
        title="Anciens membres"
        people={removed}
        timeZone={timeZone}
        anonymize={canAnonymize ? anonymizeStaffMemberAction : undefined}
        idField="staffMemberId"
        personLabel="ce membre"
        anonymizedName="Membre anonymisé"
      />
    </section>
  )
}
