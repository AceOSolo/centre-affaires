'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import {
  activateContractAction,
  archiveContractAction,
  changeContractResourceAction,
  restoreContractAction,
  type FormState,
} from './actions.ts'

const errorClass =
  'rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'

/**
 * Activation d'un brouillon. Si la ressource est déjà occupée sur la période,
 * la base refuse : l'erreur nomme ce qui l'occupe, juste sous le bouton, avec
 * le chemin pour changer la ressource du brouillon.
 */
export function ActivateForm({
  contractId,
  resourceLabel,
}: {
  contractId: string
  /** Ressource que l'activation occupera, nulle s'il n'y en a pas. */
  resourceLabel: string | null
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    activateContractAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={contractId} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          aria-describedby={`activate-hint${state?.error ? ' activate-error' : ''}`}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Activation…' : 'Activer le contrat'}
        </button>
        <span id="activate-hint" className="text-xs text-muted-foreground">
          Un brouillon n’est pas facturable.
          {resourceLabel && ` L’activation occupe ${resourceLabel} sur toute la période.`}
        </span>
      </div>
      {state?.error && (
        <div id="activate-error" role="alert" className={errorClass}>
          <p>{state.error}</p>
          <p className="mt-2">
            <Link
              href={`/contrats/${contractId}/modifier#resourceId`}
              className="font-medium underline underline-offset-2"
            >
              Changer la ressource du brouillon
            </Link>
          </p>
        </div>
      )}
    </form>
  )
}

/**
 * Changement de ressource d'un contrat en cours : l'occupation suit (ADR 018).
 * Vers une ressource déjà occupée, l'erreur revient sous le champ.
 */
export function ResourceForm({
  contractId,
  resourceId,
  resources,
}: {
  contractId: string
  resourceId: string | null
  resources: Resource[]
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    changeContractResourceAction,
    null,
  )
  const error = state?.fieldErrors?.resourceId

  return (
    <form
      // Remonté après un refus pour garder la ressource demandée sélectionnée.
      key={state?.values?.resourceId ?? resourceId ?? ''}
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={contractId} />
      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={{ resourceId: 'Ressource' }}
        message={state?.error}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="block text-sm font-medium text-foreground" htmlFor="resourceId">
            Changer de ressource
          </label>
          <select
            id="resourceId"
            name="resourceId"
            defaultValue={state?.values?.resourceId ?? resourceId ?? ''}
            aria-invalid={error ? true : undefined}
            aria-describedby={`resourceId-hint${error ? ' resourceId-error' : ''}`}
            className="mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive"
          >
            <option value="">Aucune — libérer la ressource</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 sm:self-auto"
        >
          {pending ? 'Enregistrement…' : 'Changer'}
        </button>
      </div>
      <p id="resourceId-hint" className="text-xs text-muted-foreground">
        L’occupation passe sur la nouvelle ressource pour toute la période du contrat.
      </p>
      {error && (
        <p id="resourceId-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

/** Désarchivage : le contrat revient dans les listes, son occupation aussi. */
export function RestoreForm({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    restoreContractAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={contractId} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? 'Désarchivage…' : 'Désarchiver le contrat'}
      </button>
      {state?.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}
    </form>
  )
}

/**
 * Archivage, après confirmation dans un dialogue. Jamais de suppression
 * physique (décision 6) : le contrat et son numéro restent consultables.
 */
export function ArchiveButton({
  contractId,
  reference,
  active,
  resourceLabel,
}: {
  contractId: string
  reference: string
  /** Un contrat en cours se résilie d'ordinaire : l'archiver le libère. */
  active: boolean
  resourceLabel: string | null
}) {
  return (
    <ConfirmDialog
      triggerLabel="Archiver le contrat…"
      triggerClassName="self-start rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
      title={`Archiver le contrat ${reference} ?`}
      confirmLabel="Archiver"
      pendingLabel="Archivage…"
      action={archiveContractAction}
      fields={{ id: contractId }}
    >
      <p>
        Le contrat sort de la liste des contrats. Il reste consultable, avec son numéro, depuis
        le filtre « Archivés », et peut être désarchivé.
      </p>
      {resourceLabel && (
        <p>
          La ressource {resourceLabel} n’est plus occupée au titre de ce contrat
          {active ? ', dès maintenant' : ''}.
        </p>
      )}
      {active && (
        <p className="font-medium">
          Ce contrat est en cours. Pour y mettre fin à une date donnée, résiliez-le plutôt.
        </p>
      )}
    </ConfirmDialog>
  )
}
