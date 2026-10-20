'use client'

import Link from 'next/link'
import { useState } from 'react'

import { AccountStateBadge } from './account-state-badge.tsx'
import { BanForm } from './ban-form.tsx'
import { LiftButton } from './lift-button.tsx'

/** Une ligne prête à afficher : dates et libellés mis en forme par le serveur. */
export type AccountTableRow = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdOn: string
  staffRole: string | null
  companies: { clientId: string; clientName: string; online: boolean }[]
  banned: boolean
  stateLabel: string
  /** Raison pour laquelle la ligne ne se coche pas (équipe, soi-même). */
  locked: string | null
}

/**
 * Liste des comptes avec sélection multiple (ADR 045) : bannir ou réactiver
 * plusieurs comptes d'un coup, l'action se répétant ligne par ligne.
 *
 * Les comptes de l'équipe ne se cochent pas : on ne les bannit pas d'ici
 * (`banAccounts`). Le serveur le revérifie de toute façon.
 */
export function AccountsTable({
  rows,
  today,
  canBan,
}: {
  rows: AccountTableRow[]
  today: string
  /** Droit `comptes.gerer` : sans lui, ni cases à cocher ni actions groupées. */
  canBan: boolean
}) {
  const [selected, setSelected] = useState<string[]>([])
  const selectable = rows.filter((row) => !row.locked)
  const allSelected = selectable.length > 0 && selected.length === selectable.length
  const targets = rows.filter((row) => selected.includes(row.id))
  const bannedTargets = targets.filter((row) => row.banned)

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, id] : current.filter((value) => value !== id)))

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Comptes du site, les plus récents d’abord</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {canBan && (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Tout cocher"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={(event) => setSelected(event.target.checked ? selectable.map((row) => row.id) : [])}
                    className="size-4"
                  />
                </th>
              )}
              <th className="px-4 py-3 font-medium">Compte</th>
              <th className="px-4 py-3 font-medium">Inscrit le</th>
              <th className="px-4 py-3 font-medium">Relève de</th>
              <th className="px-4 py-3 font-medium">État</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id} className={selected.includes(row.id) ? 'bg-accent/5' : undefined}>
                {canBan && (
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Cocher ${row.email}`}
                      checked={selected.includes(row.id)}
                      disabled={row.locked !== null}
                      title={row.locked ?? undefined}
                      onChange={(event) => toggle(row.id, event.target.checked)}
                      className="size-4"
                    />
                  </td>
                )}
                <td className="px-4 py-3 align-top">
                  <Link
                    href={`/comptes/${row.id}`}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {row.name || row.email}
                  </Link>
                  <div className="text-muted-foreground">{row.email}</div>
                  {!row.emailVerified && (
                    <div className="text-xs text-muted-foreground">Adresse non confirmée</div>
                  )}
                </td>
                <td className="tabular px-4 py-3 align-top">{row.createdOn}</td>
                <td className="px-4 py-3 align-top">
                  {row.staffRole && <div>Équipe · {row.staffRole}</div>}
                  {row.companies.map((company) => (
                    <div key={company.clientId}>
                      <Link
                        href={`/clients/${company.clientId}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {company.clientName}
                      </Link>
                      {company.online && (
                        <span className="ml-1 text-xs text-muted-foreground">(inscrit en ligne)</span>
                      )}
                    </div>
                  ))}
                  {!row.staffRole && row.companies.length === 0 && (
                    <span className="text-muted-foreground">
                      {row.emailVerified ? 'Aucune entreprise' : 'En attente de confirmation'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 align-top">
                  <AccountStateBadge banned={row.banned} label={row.stateLabel} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canBan && (
        <section
          aria-labelledby="actions-groupees"
          className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
        >
          <h2 id="actions-groupees" className="text-sm font-semibold tracking-tight">
            Sélection{' '}
            <span aria-live="polite" className="font-normal text-muted-foreground">
              ({selected.length} {selected.length > 1 ? 'comptes cochés' : 'compte coché'})
            </span>
          </h2>
          {selected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Cochez des comptes dans la liste pour les bannir ou les réactiver ensemble.
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              <BanForm
                targets={targets.map((row) => ({ id: row.id, label: row.email }))}
                today={today}
                submitLabel={`Bannir ${targets.length > 1 ? `les ${targets.length} comptes` : 'le compte'}`}
              />
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  {bannedTargets.length > 0
                    ? `${bannedTargets.length} ${bannedTargets.length > 1 ? 'comptes bannis' : 'compte banni'} dans la sélection.`
                    : 'Aucun compte banni dans la sélection.'}
                </p>
                <LiftButton
                  ids={bannedTargets.map((row) => row.id)}
                  label={bannedTargets.length > 1 ? `Réactiver les ${bannedTargets.length} comptes` : 'Réactiver'}
                />
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
