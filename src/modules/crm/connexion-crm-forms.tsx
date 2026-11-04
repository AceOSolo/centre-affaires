'use client'

import { useActionState, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { BanIcon, CheckIcon } from '../../components/ui/icons.tsx'
import {
  clearCrmKeyAction,
  crmTokenAction,
  saveCrmFlowsAction,
  saveCrmSettingsAction,
  testCrmConnectionAction,
  type CrmFormState,
  type CrmTestState,
  type CrmTokenState,
} from './actions.ts'

/*
 * Formulaires de l'écran « Connexion au CRM » (ADR 065). Toute soumission rend
 * un état : libellé d'attente sur le bouton, puis succès ou échec annoncé
 * (`aria-live`), placé près du bouton qui l'a provoqué.
 */

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const helpClass = 'mt-1 text-xs text-muted-foreground'
const primaryButton = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover disabled:opacity-50 ${focus}`
const secondaryButton = `rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50 ${focus}`
const dangerButton = `rounded-md border border-destructive/30 bg-white px-4 py-2 text-sm font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5 disabled:opacity-50 ${focus}`

/** Réponse d'un formulaire, annoncée aux lecteurs d'écran. La région existe avant d'être remplie. */
function Outcome({ ok, message }: { ok?: string; message?: string }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {ok && (
        <span className="inline-flex items-start gap-1.5 text-primary">
          <CheckIcon size={20} className="shrink-0" />
          {ok}
        </span>
      )}
      {message && (
        <span className="inline-flex items-start gap-1.5 text-destructive">
          <BanIcon size={20} className="shrink-0" />
          {message}
        </span>
      )}
    </p>
  )
}

/* ------------------------------------------------------------------------ */
/* Le CRM, son adresse, la clé pour l'appeler                               */
/* ------------------------------------------------------------------------ */

export function CrmSettingsForm({
  connectors,
  connector,
  baseUrl,
  keyStatus,
  keyLabel,
  keyHelp,
  urlHelp,
  urlExample,
}: {
  connectors: { value: string; label: string }[]
  connector: string
  baseUrl: string
  /** « Clé enregistrée le … » ou « Aucune clé ». */
  keyStatus: string
  keyLabel: string
  keyHelp: string
  urlHelp: string
  urlExample: string
}) {
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(saveCrmSettingsAction, null)
  const errors = state?.fieldErrors
  const describe = (field: 'connector' | 'baseUrl' | 'key', help: boolean) =>
    [help ? `${field}-aide` : '', errors?.[field] ? `${field}-erreur` : ''].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex flex-col gap-3">
      {/* Remonté après chaque envoi : la clé saisie ne reste jamais dans le champ. */}
      <form key={JSON.stringify(state ?? '')} action={formAction} className="flex flex-col gap-4" noValidate>
        <ErrorSummary
          errors={errors as Record<string, string> | undefined}
          labels={{ connector: 'CRM', baseUrl: 'Adresse du CRM', key: keyLabel }}
        />
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <label className={labelClass} htmlFor="connector">
              CRM
            </label>
            <select
              id="connector"
              name="connector"
              defaultValue={state?.values?.connector ?? connector}
              aria-invalid={errors?.connector ? true : undefined}
              aria-describedby={describe('connector', true)}
              className={`${fieldClass} mt-1`}
            >
              {connectors.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p id="connector-aide" className={helpClass}>
              D’autres CRM viendront s’ajouter à la liste.
            </p>
            {errors?.connector && (
              <p id="connector-erreur" role="alert" className="mt-1 text-xs text-destructive">
                {errors.connector}
              </p>
            )}
          </div>
          <div>
            <label className={labelClass} htmlFor="baseUrl">
              Adresse du CRM <span className="font-normal text-muted-foreground">(facultative)</span>
            </label>
            <input
              id="baseUrl"
              name="baseUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              defaultValue={state?.values?.baseUrl ?? baseUrl}
              aria-invalid={errors?.baseUrl ? true : undefined}
              aria-describedby={describe('baseUrl', true)}
              className={`${fieldClass} mt-1`}
            />
            <p id="baseUrl-aide" className={helpClass}>
              {urlHelp} Par exemple : {urlExample}
            </p>
            {errors?.baseUrl && (
              <p id="baseUrl-erreur" role="alert" className="mt-1 text-xs text-destructive">
                {errors.baseUrl}
              </p>
            )}
          </div>
        </div>
        <div className="max-w-xl">
          <label className={labelClass} htmlFor="key">
            {keyLabel} <span className="font-normal text-muted-foreground">(facultative)</span>
          </label>
          <input
            id="key"
            name="key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={errors?.key ? true : undefined}
            aria-describedby={describe('key', true)}
            className={`${fieldClass} mt-1`}
          />
          <p id="key-aide" className={helpClass}>
            {keyStatus} {keyHelp} Laisser vide pour garder la clé enregistrée.
          </p>
          {errors?.key && (
            <p id="key-erreur" role="alert" className="mt-1 text-xs text-destructive">
              {errors.key}
            </p>
          )}
        </div>
        <div>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
      <Outcome ok={state?.ok} />
    </div>
  )
}

export function ClearCrmKeyForm() {
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(clearCrmKeyAction, null)
  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <button type="submit" disabled={pending} className={dangerButton}>
          {pending ? 'Effacement…' : 'Effacer la clé'}
        </button>
      </form>
      <Outcome ok={state?.ok} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Le jeton que le CRM présente au site                                     */
/* ------------------------------------------------------------------------ */

export function CrmTokenPanel({
  hasToken,
  serverToken,
  appUrl,
  productsRoute,
}: {
  hasToken: boolean
  /** Nom de la variable du serveur encore en vigueur (`DOLIBARR_API_TOKEN`), si elle l'est. */
  serverToken?: string
  /** Adresse publique du site (`APP_URL`), pour composer l'adresse du webhook. */
  appUrl: string
  /** Route du webhook des produits, s'il en a une (Dolibarr). */
  productsRoute?: string
}) {
  // Le jeton tout juste généré vit dans l'état de l'action, tant que la page
  // reste ouverte ; un retrait le remplace par son propre message.
  const [state, formAction, pending] = useActionState<CrmTokenState, FormData>(crmTokenAction, null)
  const token = state?.token

  return (
    <div className="flex flex-col gap-3">
      {token && <OneTimeToken token={token} appUrl={appUrl} productsRoute={productsRoute} />}

      <div className="flex flex-wrap items-start gap-2">
        {hasToken || serverToken ? (
          // Confirmation sans script : remplacer le jeton en vigueur coupe le
          // CRM jusqu'à ce que son développeur pose le nouveau.
          <details className="sm:max-w-sm">
            <summary className={`${hasToken ? secondaryButton : primaryButton} cursor-pointer list-none text-center`}>
              {hasToken ? 'Renouveler le jeton…' : 'Générer un jeton…'}
            </summary>
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {hasToken ? 'L’ancien jeton' : `Le jeton du serveur (${serverToken})`} cesse aussitôt de
                fonctionner : le CRM n’appelle plus le site tant que son développeur n’a pas posé le nouveau.
              </p>
              <form action={formAction}>
                <input type="hidden" name="intent" value="generer" />
                <button type="submit" disabled={pending} className={`${primaryButton} w-full`}>
                  {pending ? 'Génération…' : hasToken ? 'Confirmer le renouvellement' : 'Confirmer et générer'}
                </button>
              </form>
            </div>
          </details>
        ) : (
          <form action={formAction}>
            <input type="hidden" name="intent" value="generer" />
            <button type="submit" disabled={pending} className={primaryButton}>
              {pending ? 'Génération…' : 'Générer un jeton'}
            </button>
          </form>
        )}
        {hasToken && (
          <details className="sm:max-w-sm">
            <summary className={`${dangerButton} cursor-pointer list-none text-center`}>Retirer le jeton…</summary>
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Le CRM ne peut plus appeler le site avec ce jeton. Si le serveur a encore son ancien jeton,
                celui-ci vaut de nouveau.
              </p>
              <form action={formAction}>
                <input type="hidden" name="intent" value="retirer" />
                <button type="submit" disabled={pending} className={`${dangerButton} w-full`}>
                  {pending ? 'Retrait…' : 'Confirmer le retrait'}
                </button>
              </form>
            </div>
          </details>
        )}
      </div>
      <Outcome ok={state?.ok} />
    </div>
  )
}

/** Le jeton, montré une fois, avec ce qu'il faut pour le remettre au développeur du CRM. */
function OneTimeToken({ token, appUrl, productsRoute }: { token: string; appUrl: string; productsRoute?: string }) {
  const [copied, setCopied] = useState<string | undefined>()
  const webhook = productsRoute && appUrl ? `${appUrl.replace(/\/+$/, '')}${productsRoute}?jeton=${token}` : undefined

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
    } catch {
      setCopied(undefined)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent bg-accent/5 px-4 py-3">
      <p className="text-sm font-medium">Copiez ce jeton maintenant : il ne sera plus jamais affiché.</p>
      <div>
        <label className={labelClass} htmlFor="jeton-genere">
          Jeton du CRM
        </label>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <input
            id="jeton-genere"
            readOnly
            value={token}
            onFocus={(event) => event.currentTarget.select()}
            className={`${fieldClass} break-all`}
          />
          <button type="button" onClick={() => copy('jeton', token)} className={`${secondaryButton} shrink-0`}>
            Copier le jeton
          </button>
        </div>
        <p className={helpClass}>
          À présenter dans l’en-tête <span className="font-medium text-foreground">Authorization: Bearer</span> suivi du
          jeton.
        </p>
      </div>
      {webhook && (
        <div>
          <label className={labelClass} htmlFor="webhook-genere">
            Adresse du webhook des produits
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id="webhook-genere"
              readOnly
              value={webhook}
              onFocus={(event) => event.currentTarget.select()}
              className={`${fieldClass} break-all`}
            />
            <button type="button" onClick={() => copy('webhook', webhook)} className={`${secondaryButton} shrink-0`}>
              Copier l’adresse
            </button>
          </div>
          <p className={helpClass}>À déclarer comme cible du module Webhook de Dolibarr, à la place de l’ancienne.</p>
        </div>
      )}
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {copied === 'jeton' ? 'Jeton copié.' : copied === 'webhook' ? 'Adresse copiée.' : ''}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Flux échangés                                                            */
/* ------------------------------------------------------------------------ */

export type CrmFlowOption = {
  id: string
  label: string
  description: string
  direction: string
  routes: readonly string[]
  /** Servi par le site pour ce CRM ; sinon « à venir », non cochable. */
  available: boolean
  enabled: boolean
}

export function CrmFlowsForm({
  flows,
  consumptionsFrom,
}: {
  flows: CrmFlowOption[]
  /** Premier jour des consommations transmises (ADR 066) ; nul tant que le flux n'a pas été ouvert. */
  consumptionsFrom: string | null
}) {
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(saveCrmFlowsAction, null)
  const fromError = state?.fieldErrors?.consumptionsFrom
  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3" noValidate>
        <ErrorSummary
          errors={state?.fieldErrors as Record<string, string> | undefined}
          labels={{ flows: 'Flux', consumptionsFrom: 'Date de départ des consommations' }}
        />
        <fieldset
          id="flows"
          className="flex flex-col gap-2"
          aria-describedby={state?.fieldErrors?.flows ? 'flux-erreur' : undefined}
        >
          <legend className="sr-only">Flux activés</legend>
          {flows.map((flow) => (
            <div
              key={flow.id}
              className={`flex gap-3 rounded-lg border border-border px-4 py-3 ${flow.available ? 'bg-white' : 'bg-muted'}`}
            >
              {/* Le label agrandit la cible au-delà des 24 px demandés. */}
              <label htmlFor={`flux-${flow.id}`} className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center">
                <input
                  id={`flux-${flow.id}`}
                  type="checkbox"
                  name="flows"
                  value={flow.id}
                  defaultChecked={flow.available && flow.enabled}
                  disabled={!flow.available}
                  aria-describedby={`flux-${flow.id}-aide`}
                  className={`size-4 accent-primary ${focus}`}
                />
              </label>
              <div className="min-w-0">
                <label htmlFor={`flux-${flow.id}`} className="text-sm font-medium">
                  {flow.label}
                </label>
                <span className="ml-2 text-xs text-muted-foreground">{flow.direction}</span>
                {!flow.available && (
                  <span className="ml-2 rounded-sm border border-border bg-white px-1.5 py-0.5 text-xs text-muted-foreground">
                    À venir
                  </span>
                )}
                <p id={`flux-${flow.id}-aide`} className="mt-0.5 text-sm text-muted-foreground">
                  {flow.description}
                  {flow.available && flow.routes.length > 0 && (
                    <span className="mt-0.5 block text-xs break-words">{flow.routes.join(' · ')}</span>
                  )}
                </p>
                {flow.id === 'consumptions' && flow.available && (
                  <div className="mt-2 max-w-xs">
                    <label className={labelClass} htmlFor="consumptionsFrom">
                      Transmettre les consommations faites à partir du
                    </label>
                    <input
                      id="consumptionsFrom"
                      name="consumptionsFrom"
                      type="date"
                      defaultValue={consumptionsFrom ?? ''}
                      aria-invalid={fromError ? true : undefined}
                      aria-describedby={['consumptionsFrom-aide', fromError ? 'consumptionsFrom-erreur' : ''].filter(Boolean).join(' ')}
                      className={`${fieldClass} mt-1 tabular`}
                    />
                    <p id="consumptionsFrom-aide" className={helpClass}>
                      Rien d’antérieur ne part : ce que le centre a déjà facturé à la main ne l’est pas deux fois.
                      Vide : à partir d’aujourd’hui.
                    </p>
                    {fromError && (
                      <p id="consumptionsFrom-erreur" role="alert" className="mt-1 text-xs text-destructive">
                        {fromError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </fieldset>
        {state?.fieldErrors?.flows && (
          <p id="flux-erreur" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.flows}
          </p>
        )}
        <div>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Enregistrement…' : 'Enregistrer les flux'}
          </button>
        </div>
      </form>
      <Outcome ok={state?.ok} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Tester la connexion                                                      */
/* ------------------------------------------------------------------------ */

export function CrmTestForm() {
  const [state, formAction, pending] = useActionState<CrmTestState, FormData>(testCrmConnectionAction, null)
  return (
    <div className="flex flex-col gap-3">
      <form action={formAction}>
        <button type="submit" disabled={pending} className={secondaryButton}>
          {pending ? 'Test en cours…' : 'Tester la connexion'}
        </button>
      </form>
      <div aria-live="polite">
        {state?.lines && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {state.lines.map((line, index) => (
              <li
                key={`${state.at}-${index}`}
                className={`flex items-start gap-1.5 ${line.ok === false ? 'text-destructive' : 'text-foreground'}`}
              >
                {line.ok === true && <CheckIcon size={20} className="shrink-0 text-primary" />}
                {line.ok === false && <BanIcon size={20} className="shrink-0" />}
                {line.ok === null && <span aria-hidden="true" className="inline-block size-5 shrink-0" />}
                <span>
                  <span className="sr-only">{line.ok === true ? 'Réussi : ' : line.ok === false ? 'Échec : ' : 'Information : '}</span>
                  {line.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
