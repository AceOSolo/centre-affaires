import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import type { AnonymizeState } from './actions.ts'
import type { RemovedPerson } from './anonymisation.ts'
import { formatCentreDay } from './affichage.ts'

/**
 * Personnes retirées — accès à l'espace client d'une entreprise, ou membres
 * de l'équipe (R29, ADR 040). Leur ligne reste : elle signe des demandes,
 * des ouvertures, des consultations. Leur nom et leur adresse partent au
 * terme de la durée du centre, ou plus tôt à leur demande (droit à
 * l'effacement), par l'exploitant.
 *
 * L'état se lit en toutes lettres, jamais à la seule teinte.
 */
export function RemovedPeopleTable({
  id,
  title,
  people,
  timeZone,
  anonymize,
  idField,
  personLabel,
  anonymizedName,
}: {
  id: string
  title: string
  people: RemovedPerson[]
  timeZone: string
  /** Action d'anonymisation à la demande ; absente sans le droit `rgpd.anonymiser`. */
  anonymize?: (previous: AnonymizeState, formData: FormData) => Promise<AnonymizeState>
  /** Nom du champ qui porte l'identifiant de la personne. */
  idField: string
  /** « cette personne », « ce membre » : pour la nommer dans le dialogue. */
  personLabel: string
  /** Nom que la base donne à la ligne anonymisée (migration 0043). */
  anonymizedName: string
}) {
  if (people.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 id={id} className="text-sm font-medium text-foreground">
        {title} <span className="font-normal text-muted-foreground">({people.length})</span>
      </h3>
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table aria-labelledby={id} className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Personne</th>
              <th scope="col" className="px-4 py-3 font-medium">Retiré le</th>
              <th scope="col" className="px-4 py-3 font-medium">Nom et adresse</th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {people.map((person) => {
              const name = person.anonymizedAt ? null : (person.fullName ?? person.email)
              return (
                <tr key={person.id}>
                  <td className="px-4 py-3">
                    {person.anonymizedAt ? (
                      <span className="text-muted-foreground">{person.fullName ?? anonymizedName}</span>
                    ) : (
                      <>
                        <span className="font-medium">{person.fullName ?? person.email}</span>
                        {person.fullName && (
                          <span className="block text-xs text-muted-foreground">{person.email}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                    {formatCentreDay(person.removedAt, timeZone)}
                  </td>
                  <td className="px-4 py-3">
                    {person.anonymizedAt
                      ? `Anonymisés le ${formatCentreDay(person.anonymizedAt, timeZone)}`
                      : `Conservés jusqu’au ${formatCentreDay(person.dueAfter, timeZone)}, puis anonymisés`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {anonymize && name && (
                      <ConfirmDialog
                        triggerLabel="Anonymiser…"
                        triggerAriaLabel={`Anonymiser ${name}`}
                        triggerClassName="rounded-md border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                        title={`Anonymiser ${name} ?`}
                        confirmLabel="Anonymiser définitivement"
                        pendingLabel="Anonymisation…"
                        action={anonymize}
                        fields={{ [idField]: person.id }}
                      >
                        <p>
                          Le nom et l’adresse de {personLabel} sont effacés tout de suite, sans
                          attendre la durée de conservation, et son compte est détaché.
                        </p>
                        <p>
                          La ligne reste, sous le nom « {anonymizedName} » : elle signe des
                          demandes, des ouvertures et des consultations passées. Rien ne se
                          rétablit ensuite.
                        </p>
                      </ConfirmDialog>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
