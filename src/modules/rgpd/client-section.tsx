import { CheckIcon } from '../../components/ui/icons.tsx'
import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { todayIsoDate } from '../../lib/dates.ts'
import type { Client } from '../clients/schema.ts'
import { anonymizeClientAction, anonymizeClientMemberAction } from './actions.ts'
import { formatCalendarDate, formatCentreDay } from './affichage.ts'
import { findClientAnonymizer, findClientRetention, listRemovedClientMembers } from './anonymisation.ts'
import { AnonymizationBasisFields } from './basis-fields.tsx'
import { formatRetentionMonths } from './durees.ts'
import { anonymizationTraceLabel } from './fondement.ts'
import { LastContactForm } from './last-contact-form.tsx'
import { RemovedPeopleTable } from './removed-people.tsx'

/**
 * Confirmations après une anonymisation, au retour sur la fiche. Une `Map`
 * et non un objet : `?rgpd=constructor` ne doit rien trouver.
 */
const notices = new Map([
  ['anonymise', 'Fiche anonymisée. Les factures émises gardent l’identité de l’acheteur figée à leur émission.'],
  ['acces-anonymise', 'Accès anonymisé : son nom et son adresse sont effacés.'],
])

/**
 * Conservation des données d'une entreprise, sur sa fiche (R29, ADR 040) :
 * dernière activité, dernier contact noté, date d'anonymisation automatique,
 * exclusions ; pour l'exploitant, l'anonymisation à la demande (droit à
 * l'effacement), refusée et expliquée tant qu'une exclusion demeure ; les
 * accès retirés et leur anonymisation.
 */
export async function ClientRetentionSection({
  client,
  canAnonymize,
  timeZone,
  notice,
}: {
  client: Pick<
    Client,
    | 'id'
    | 'name'
    | 'status'
    | 'lastContactOn'
    | 'anonymizedAt'
    | 'anonymizedBy'
    | 'anonymizationBasis'
    | 'erasureRequestedOn'
  >
  /** Droit `rgpd.anonymiser` (exploitant). */
  canAnonymize: boolean
  timeZone: string
  /** Valeur de `?rgpd=` au retour d'une anonymisation. */
  notice?: string
}) {
  const [retention, removed, anonymizer] = await Promise.all([
    client.anonymizedAt ? undefined : findClientRetention(client.id),
    listRemovedClientMembers(client.id),
    client.anonymizedBy ? findClientAnonymizer(client.id) : null,
  ])
  const message = notice ? notices.get(notice) : undefined
  const today = todayIsoDate(timeZone)
  // Fondement, date de la demande et auteur (ADR 041) ; rien avant qu'ils ne soient tracés.
  const trace = anonymizationTraceLabel({
    basis: client.anonymizationBasis,
    erasureRequestedOn: client.erasureRequestedOn,
    byName: anonymizer,
  })

  return (
    <section id="conservation" aria-labelledby="conservation-titre" className="flex flex-col gap-3">
      <h2 id="conservation-titre" className="text-sm font-semibold tracking-tight">
        Conservation des données (RGPD)
      </h2>

      {message && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
        >
          <CheckIcon size={20} />
          {message}
        </p>
      )}

      {client.anonymizedAt ? (
        <div className="rounded-lg border border-border bg-white px-5 py-4 text-sm">
          <p className="font-medium">
            Fiche anonymisée le {formatCentreDay(client.anonymizedAt, timeZone)}
            {trace ? `, ${trace}` : ''}.
          </p>
          <p className="mt-1 max-w-[70ch] text-muted-foreground">
            Raison sociale, coordonnées, SIRET, notes, contacts et accès à l’espace client sont
            effacés, comme l’expéditeur des plis et les coordonnées des demandeurs. Restent les
            factures et avoirs émis, avec l’identité de l’acheteur figée à leur émission (10 ans),
            les paiements, les contrats, les états des lieux et le compte auxiliaire. La fiche ne
            change plus.
          </p>
        </div>
      ) : (
        retention && (
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4 text-sm">
            <dl className="grid grid-cols-[12rem_1fr] gap-y-2">
              <dt className="text-muted-foreground">Dernière activité</dt>
              <dd className="tabular">{formatCalendarDate(retention.lastActivityOn)}</dd>

              <dt className="text-muted-foreground">Dernier contact noté</dt>
              <dd className="tabular">
                {client.lastContactOn ? formatCalendarDate(client.lastContactOn) : 'aucun'}
              </dd>

              <dt className="text-muted-foreground">Anonymisation automatique</dt>
              <dd>
                {retention.blockers.length > 0 ? (
                  'Suspendue tant qu’une exclusion demeure (ci-dessous).'
                ) : (
                  <>
                    Après le <span className="tabular">{formatCalendarDate(retention.dueAfter)}</span>,
                    sans nouvelle activité : {formatRetentionMonths(retention.retentionMonths)} après
                    la dernière activité, durée des{' '}
                    {client.status === 'prospect' ? 'prospects' : 'clients'}.
                  </>
                )}
              </dd>
            </dl>

            <LastContactForm clientId={client.id} today={today} />

            {retention.blockers.length > 0 ? (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
                <p className="font-medium">L’anonymisation n’est pas possible pour l’instant :</p>
                <ul className="mt-1 list-disc pl-5">
                  {retention.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                <p className="mt-2 text-muted-foreground">
                  Soldez ou annulez par avoir, terminez les contrats et les services, révoquez le
                  mandat, traitez les demandes, puis recommencez. Une demande d’effacement reçue
                  dans l’intervalle se note et se traite ensuite.
                </p>
              </div>
            ) : canAnonymize ? (
              <div>
                <p className="max-w-[70ch] text-muted-foreground">
                  À la demande de l’entreprise ou de la personne concernée (droit à l’effacement),
                  la fiche s’anonymise sans attendre sa durée.
                </p>
                <div className="mt-2">
                  <ConfirmDialog
                    triggerLabel="Anonymiser la fiche…"
                    triggerClassName="rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
                    title={`Anonymiser ${client.name} ?`}
                    confirmLabel="Anonymiser définitivement"
                    pendingLabel="Anonymisation…"
                    action={anonymizeClientAction}
                    fields={{ clientId: client.id }}
                  >
                    <p>
                      Sont effacés : raison sociale, forme, SIRET, TVA, coordonnées, adresse et
                      notes de la fiche ; ses contacts et ses accès à l’espace client ;
                      l’expéditeur et la note de ses plis, les consignes et adresses de ses
                      demandes de courrier ; les coordonnées et notes de ses réservations ; les
                      notes de ses contrats ; les destinataires des messages envoyés. La fiche
                      est archivée.
                    </p>
                    <p>
                      Restent intacts : factures et avoirs émis, leurs lignes, paiements,
                      relances, contrats et leurs documents, états des lieux, compte
                      auxiliaire.
                    </p>
                    <p className="font-medium">Rien ne se rétablit ensuite.</p>
                    <AnonymizationBasisFields today={today} />
                  </ConfirmDialog>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">
                L’anonymisation à la demande (droit à l’effacement) est réservée à l’exploitant.
              </p>
            )}
          </div>
        )
      )}

      <RemovedPeopleTable
        id="acces-retires"
        title="Accès retirés"
        people={removed}
        timeZone={timeZone}
        today={today}
        anonymize={canAnonymize ? anonymizeClientMemberAction : undefined}
        idField="memberId"
        personLabel="cette personne"
        anonymizedName="Personne anonymisée"
      />
    </section>
  )
}
