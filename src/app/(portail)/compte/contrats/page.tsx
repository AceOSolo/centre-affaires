import Link from 'next/link'

import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
} from '../../../../components/ui/icons.tsx'
import { formatCalendarDate, formatDateTime, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { listContractsForAccounts } from '../../../../modules/contrats/compte-queries.ts'
import {
  clientContractState,
  clientContractToneStyles,
  type ClientContractTone,
} from '../../../../modules/contrats/compte-regles.ts'
import { billingPeriodSuffixes, contractTypeLabels } from '../../../../modules/contrats/labels.ts'
import { lastContractDay } from '../../../../modules/contrats/occupation.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Mes contrats' }

const toneIcons: Record<ClientContractTone, typeof CheckIcon> = {
  upcoming: CalendarIcon,
  active: CheckIcon,
  ending: ClockIcon,
  ended: FileTextIcon,
  terminated: FileTextIcon,
}

/**
 * Contrats des entreprises du compte (R17) : où ils en sont, leur période,
 * la ressource et le prix en vigueur, l'engagement, les avenants signés, et
 * chaque version archivée du document, ouverte en vue imprimable.
 *
 * Mobile d'abord (R25) : une carte par contrat, les liens vers les documents
 * en pleine largeur et à 44 px de haut.
 */
export default async function MesContratsPage() {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const today = todayIsoDate(timeZone)
  const contracts = await listContractsForAccounts(accounts, today)
  const several = accounts.length > 1

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Mes contrats</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Vos contrats avec le centre, leurs avenants et chaque document remis, tel qu’il a été
          archivé.
        </p>
      </div>

      {contracts.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <FileTextIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Aucun contrat pour l’instant. Un contrat signé avec le centre apparaîtra ici, avec ses
            documents.
          </p>
          {tenant.phone && (
            <a
              href={`tel:${tenant.phone.replace(/\s/g, '')}`}
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium text-primary transition-colors hover:bg-muted"
            >
              Appeler le centre au {tenant.phone}
            </a>
          )}
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-4">
          {contracts.map((contract) => {
            const state = clientContractState(contract, today)
            const Icon = toneIcons[state.tone]
            const lastDay = lastContractDay(contract)
            const money = (cents: number) => formatCents(cents, contract.currency)
            return (
              <li key={contract.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                <article aria-labelledby={`contrat-${contract.id}`} className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${clientContractToneStyles[state.tone]}`}
                    >
                      <Icon size={16} />
                      {state.label}
                    </span>
                    <span className="text-muted-foreground">{contractTypeLabels[contract.contractType]}</span>
                    {several && <span className="text-muted-foreground">· {contract.clientName}</span>}
                  </div>

                  <div>
                    <h2 id={`contrat-${contract.id}`} className="text-base font-semibold">
                      Contrat <span className="tabular">{contract.reference}</span>
                    </h2>
                    {contract.offerName && (
                      <p className="text-sm text-muted-foreground">Offre « {contract.offerName} »</p>
                    )}
                  </div>

                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Période</dt>
                      <dd className="tabular">
                        {lastDay
                          ? `Du ${formatCalendarDate(contract.startsOn)} au ${formatCalendarDate(lastDay)}`
                          : `Depuis le ${formatCalendarDate(contract.startsOn)}, sans terme`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ressource</dt>
                      <dd>
                        {contract.currentResource
                          ? `${contract.currentResource.name} (${resourceTypeLabels[contract.currentResource.resourceType].toLowerCase()})`
                          : 'Aucune ressource attribuée'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Prix</dt>
                      <dd className="tabular">
                        {money(contract.currentAmountCents)} HT {billingPeriodSuffixes[contract.billingPeriod]}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Engagement</dt>
                      <dd className="tabular">
                        {contract.commitmentMonths && contract.commitmentEndsOn
                          ? `${contract.commitmentMonths} mois, jusqu’au ${formatCalendarDate(contract.commitmentEndsOn)}`
                          : 'Sans engagement'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Préavis de résiliation</dt>
                      <dd className="tabular">{contract.noticeDays} jours</dd>
                    </div>
                    {contract.tacitRenewal && contract.renewalMonths && (
                      <div>
                        <dt className="text-muted-foreground">Reconduction</dt>
                        <dd>Tacite, par périodes de {contract.renewalMonths} mois</dd>
                      </div>
                    )}
                  </dl>

                  {contract.amendments.length > 0 && (
                    <section aria-labelledby={`avenants-${contract.id}`} className="flex flex-col gap-2">
                      <h3 id={`avenants-${contract.id}`} className="text-sm font-semibold">
                        Avenants signés
                      </h3>
                      <ul className="flex flex-col gap-2 text-sm">
                        {contract.amendments.map((amendment) => (
                          <li key={amendment.number} className="rounded-md bg-muted px-3 py-2">
                            <p className="font-medium">
                              Avenant n° {amendment.number}, à partir du{' '}
                              <span className="tabular">{formatCalendarDate(amendment.effectiveOn)}</span>
                            </p>
                            {amendment.reason && <p>{amendment.reason}</p>}
                            <p className="text-muted-foreground">
                              {[
                                amendment.amountCents !== null
                                  ? `Prix : ${money(amendment.amountCents)} HT ${billingPeriodSuffixes[contract.billingPeriod]}`
                                  : null,
                                amendment.changesResource
                                  ? amendment.resourceName
                                    ? `Ressource : ${amendment.resourceName}`
                                    : 'Ressource retirée'
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ') || 'Sans changement de prix ni de ressource'}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section aria-labelledby={`documents-${contract.id}`} className="flex flex-col gap-2">
                    <h3 id={`documents-${contract.id}`} className="text-sm font-semibold">
                      Documents
                    </h3>
                    {contract.documents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Aucun document archivé pour ce contrat. Le centre peut vous en remettre un
                        exemplaire.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {contract.documents.map((archive) => (
                          <li key={archive.version}>
                            <Link
                              href={`/compte/contrats/${contract.id}/document?version=${archive.version}`}
                              className="flex min-h-11 flex-col justify-center gap-0.5 rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-muted sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                            >
                              <span className="inline-flex items-center gap-2 font-medium text-primary">
                                <FileTextIcon size={16} />
                                {archive.amendmentNumber === null
                                  ? 'Contrat initial'
                                  : `Avenant n° ${archive.amendmentNumber}`}
                                <span className="sr-only"> du contrat {contract.reference}</span>
                              </span>
                              <span className="text-muted-foreground tabular">
                                Version {archive.version}, archivée le{' '}
                                {formatDateTime(archive.createdAt, timeZone)}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
