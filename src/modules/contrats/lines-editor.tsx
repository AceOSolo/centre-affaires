'use client'

import { useEffect, useRef, useState } from 'react'

import { rateUnitLabels } from '../facturation/labels.ts'
import { lineNetAmountCents } from '../facturation/montants.ts'
import { rateUnits, type RateUnit } from '../facturation/schema.ts'
import { formatCents, parseAmountToCents, pickRateItem, type RateCandidate } from '../facturation/tarifs.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import {
  centsToInput,
  decodeTarget,
  formatBpAsPercent,
  lineFieldLabels,
  lineFieldName,
  linesTotals,
  parsePercentToBp,
  type LineDraft,
  type LineField,
  type LineFormValues,
} from './lignes.ts'
import { resourceDescription } from './offres.ts'

/** Ce que l'éditeur propose comme objet d'une ligne, et les prix du catalogue. */
export type LinesCatalog = {
  resources: { id: string; code: string; name: string; resourceType: ResourceType }[]
  /** Services forfaitaires : un acte se souscrit, il n'est pas une ligne de contrat. */
  services: { id: string; name: string; unit: RateUnit; unitPriceCents: number; vatRateBp: number }[]
  /** Prix de la grille par défaut, pour pré-remplir une ligne de ressource. */
  rates: RateCandidate[]
  defaultVatRateBp: number
  /** Libellés des objets déjà portés qui ne sont plus au catalogue (archivés). */
  targetLabels?: Record<string, string>
}

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-xs font-medium text-foreground'

/** Une ligne neuve, au format de saisie. */
export function emptyLine(key: string, defaultVatRateBp: number): LineFormValues {
  return {
    key,
    id: '',
    offerItemId: '',
    target: '',
    description: '',
    quantity: '1',
    unit: 'month',
    unitPrice: '',
    discountKind: '',
    discount: '',
    vatRate: formatBpAsPercent(defaultVatRateBp),
    recurring: 'on',
  }
}

/** Une ligne saisie, lue sans exiger qu'elle soit complète : pour annoncer son montant. */
function parsedLine(line: LineFormValues): LineDraft | undefined {
  const quantity = Number(line.quantity)
  const unitPriceCents = parseAmountToCents(line.unitPrice)
  const vatRateBp = parsePercentToBp(line.vatRate)
  if (!/^\d+$/.test(line.quantity) || quantity < 1 || unitPriceCents === undefined) return undefined
  const discountBp = line.discountKind === 'percent' ? (parsePercentToBp(line.discount) ?? null) : null
  const discountAmountCents =
    line.discountKind === 'amount' ? (parseAmountToCents(line.discount) ?? null) : null
  return {
    offerItemId: null,
    target: decodeTarget(line.target) ?? { kind: 'none' },
    description: line.description,
    quantity,
    unit: (rateUnits as readonly string[]).includes(line.unit) ? (line.unit as RateUnit) : 'month',
    unitPriceCents,
    discountBp,
    discountAmountCents,
    vatRateBp: vatRateBp ?? 0,
    isRecurring: line.recurring === 'on',
  }
}

/** Désignation et prix proposés pour un objet, d'après le catalogue. */
function suggestion(
  target: string,
  unit: string,
  catalog: LinesCatalog,
): { description?: string; unitPriceCents?: number; unit?: RateUnit; vatRateBp?: number } {
  const decoded = decodeTarget(target)
  if (!decoded) return {}
  if (decoded.kind === 'service') {
    const service = catalog.services.find((candidate) => candidate.id === decoded.serviceId)
    return service
      ? {
          description: service.name,
          unitPriceCents: service.unitPriceCents,
          unit: service.unit,
          vatRateBp: service.vatRateBp,
        }
      : {}
  }
  const rateUnit = ((rateUnits as readonly string[]).includes(unit) ? unit : 'month') as RateUnit
  if (decoded.kind === 'resource') {
    const resource = catalog.resources.find((candidate) => candidate.id === decoded.resourceId)
    if (!resource) return {}
    const rate = pickRateItem(catalog.rates, {
      resourceId: resource.id,
      resourceType: resource.resourceType,
      unit: rateUnit,
    })
    return {
      description: resourceDescription(resource, resource.resourceType),
      unitPriceCents: rate?.amountCents,
    }
  }
  if (decoded.kind === 'type') {
    const rate = pickRateItem(catalog.rates, {
      resourceId: null,
      resourceType: decoded.resourceType,
      unit: rateUnit,
    })
    return { description: resourceTypeLabels[decoded.resourceType], unitPriceCents: rate?.amountCents }
  }
  return {}
}

/**
 * Éditeur des lignes d'un contrat ou d'un avenant (R12, ADR 025), à placer
 * dans un formulaire : chaque ligne est un groupe de champs libellés, envoyés
 * sous `ligne-<clé>-<champ>`, et `ligne` porte la liste des clés dans l'ordre.
 *
 * Le montant de chaque ligne et les totaux sont annoncés en direct par la
 * règle d'arrondi de la base ; la base les recalcule à l'écriture et fait
 * autorité. Ajouter une ligne porte le focus sur sa désignation ; la retirer
 * le ramène au bouton d'ajout.
 */
export function LinesEditor({
  lines,
  setLines,
  catalog,
  errors,
  periodSuffix,
  currency,
  emptyMessage = 'Aucune ligne : ajoutez-en une.',
}: {
  /** Lignes saisies, tenues par le formulaire qui l'accueille (`useState`). */
  lines: LineFormValues[]
  setLines: (update: (current: LineFormValues[]) => LineFormValues[]) => void
  catalog: LinesCatalog
  /** Erreurs par nom de champ, rendues par l'action serveur. */
  errors: Record<string, string>
  /** « par mois » : ce que couvre le montant d'une ligne récurrente. */
  periodSuffix: string
  currency: string
  emptyMessage?: string
}) {
  // Clés des lignes nouvelles : `n1`, `n2`… jamais réutilisées, pour que
  // React et les erreurs rattachées ne confondent pas deux lignes.
  const [nextKey, setNextKey] = useState(1)
  const focusKey = useRef<string | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (focusKey.current === null) return
    const target =
      focusKey.current === ''
        ? addButton.current
        : document.getElementById(lineFieldName(focusKey.current, 'description'))
    target?.focus()
    focusKey.current = null
  }, [lines])

  const update = (key: string, patch: Partial<LineFormValues>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  const changeTarget = (line: LineFormValues, target: string) => {
    const before = suggestion(line.target, line.unit, catalog)
    const after = suggestion(target, line.unit, catalog)
    const patch: Partial<LineFormValues> = { target }
    // La désignation et le prix suivent l'objet tant qu'ils n'ont pas été saisis.
    if (after.description && (!line.description || line.description === before.description)) {
      patch.description = after.description
    }
    if (after.unit) patch.unit = after.unit
    if (after.vatRateBp !== undefined) patch.vatRate = formatBpAsPercent(after.vatRateBp)
    const price = parseAmountToCents(line.unitPrice)
    if (after.unitPriceCents !== undefined && (!line.unitPrice || price === 0 || price === before.unitPriceCents)) {
      patch.unitPrice = centsToInput(after.unitPriceCents)
    }
    update(line.key, patch)
  }

  const add = () => {
    const key = `n${nextKey}`
    setNextKey(nextKey + 1)
    focusKey.current = key
    setLines((current) => [...current, emptyLine(key, catalog.defaultVatRateBp)])
  }

  const remove = (key: string) => {
    focusKey.current = ''
    setLines((current) => current.filter((line) => line.key !== key))
  }

  const parsed = lines.map(parsedLine)
  const totals = linesTotals(parsed.filter((line): line is LineDraft => line !== undefined))
  const money = (cents: number) => formatCents(cents, currency)

  const resourceIds = new Set(catalog.resources.map((resource) => resource.id))
  const serviceIds = new Set(catalog.services.map((service) => service.id))

  return (
    <div className="flex flex-col gap-4">
      {lines.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      )}

      {lines.map((line, index) => {
        const name = (field: LineField) => lineFieldName(line.key, field)
        const error = (field: LineField) => errors[name(field)]
        const invalid = (field: LineField, hint?: string) => ({
          id: name(field),
          name: name(field),
          'aria-invalid': error(field) ? true : undefined,
          'aria-describedby':
            [hint, error(field) && `${name(field)}-error`].filter(Boolean).join(' ') || undefined,
        })
        const amount = parsed[index]
        const decoded = decodeTarget(line.target)
        const orphan =
          line.target !== '' &&
          !(decoded?.kind === 'type') &&
          !(decoded?.kind === 'resource' && resourceIds.has(decoded.resourceId)) &&
          !(decoded?.kind === 'service' && serviceIds.has(decoded.serviceId))

        return (
          <fieldset
            key={line.key}
            className="rounded-lg border border-border bg-white px-4 pb-4 pt-2"
          >
            <legend className="px-1 text-sm font-medium text-foreground">
              Ligne {index + 1}
              {line.description && (
                <span className="font-normal text-muted-foreground"> — {line.description}</span>
              )}
            </legend>
            <input type="hidden" name="ligne" value={line.key} />
            <input type="hidden" name={name('id')} value={line.id} />
            <input type="hidden" name={name('offerItemId')} value={line.offerItemId} />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <label className={labelClass} htmlFor={name('target')}>
                  Objet
                </label>
                <select
                  {...invalid('target')}
                  value={line.target}
                  onChange={(event) => changeTarget(line, event.target.value)}
                  className={`${fieldClass} mt-1`}
                >
                  <option value="">Ligne libre, sans objet</option>
                  {orphan && (
                    <option value={line.target}>
                      {catalog.targetLabels?.[line.target] ?? 'Objet hors catalogue'}
                    </option>
                  )}
                  <optgroup label="Ressources">
                    {catalog.resources.map((resource) => (
                      <option key={resource.id} value={`resource:${resource.id}`}>
                        {resource.code} — {resource.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Types de ressource">
                    {resourceTypes.map((type) => (
                      <option key={type} value={`type:${type}`}>
                        {resourceTypeLabels[type]} (sans ressource précise)
                      </option>
                    ))}
                  </optgroup>
                  {catalog.services.length > 0 && (
                    <optgroup label="Forfaits de services">
                      {catalog.services.map((service) => (
                        <option key={service.id} value={`service:${service.id}`}>
                          {service.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <FieldError id={`${name('target')}-error`} error={error('target')} />
              </div>

              <div className="lg:col-span-8">
                <label className={labelClass} htmlFor={name('description')}>
                  Désignation
                </label>
                <input
                  {...invalid('description')}
                  value={line.description}
                  maxLength={500}
                  onChange={(event) => update(line.key, { description: event.target.value })}
                  className={`${fieldClass} mt-1`}
                />
                <FieldError id={`${name('description')}-error`} error={error('description')} />
              </div>

              <div className="lg:col-span-1">
                <label className={labelClass} htmlFor={name('quantity')}>
                  Quantité
                </label>
                <input
                  {...invalid('quantity')}
                  value={line.quantity}
                  inputMode="numeric"
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                  className={`${fieldClass} mt-1 tabular`}
                />
                <FieldError id={`${name('quantity')}-error`} error={error('quantity')} />
              </div>

              <div className="lg:col-span-2">
                <label className={labelClass} htmlFor={name('unit')}>
                  Unité
                </label>
                <select
                  {...invalid('unit')}
                  value={line.unit}
                  onChange={(event) => update(line.key, { unit: event.target.value })}
                  className={`${fieldClass} mt-1`}
                >
                  {rateUnits.map((unit) => (
                    <option key={unit} value={unit}>
                      {rateUnitLabels[unit]}
                    </option>
                  ))}
                </select>
                <FieldError id={`${name('unit')}-error`} error={error('unit')} />
              </div>

              <div className="lg:col-span-2">
                <label className={labelClass} htmlFor={name('unitPrice')}>
                  Prix unitaire HT (€)
                </label>
                <input
                  {...invalid('unitPrice')}
                  value={line.unitPrice}
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                  className={`${fieldClass} mt-1 tabular`}
                />
                <FieldError id={`${name('unitPrice')}-error`} error={error('unitPrice')} />
              </div>

              <div className="lg:col-span-2">
                <label className={labelClass} htmlFor={name('discountKind')}>
                  Remise
                </label>
                <select
                  {...invalid('discountKind')}
                  value={line.discountKind}
                  onChange={(event) =>
                    update(line.key, { discountKind: event.target.value, discount: '' })
                  }
                  className={`${fieldClass} mt-1`}
                >
                  <option value="">Aucune</option>
                  <option value="percent">En pourcentage</option>
                  <option value="amount">En montant (€)</option>
                </select>
                <FieldError id={`${name('discountKind')}-error`} error={error('discountKind')} />
              </div>

              <div className="lg:col-span-2">
                <label className={labelClass} htmlFor={name('discount')}>
                  Valeur de la remise
                  {line.discountKind === 'percent' ? ' (%)' : line.discountKind === 'amount' ? ' (€)' : ''}
                </label>
                <input
                  {...invalid('discount')}
                  value={line.discount}
                  inputMode="decimal"
                  disabled={line.discountKind === ''}
                  onChange={(event) => update(line.key, { discount: event.target.value })}
                  className={`${fieldClass} mt-1 tabular disabled:bg-muted`}
                />
                <FieldError id={`${name('discount')}-error`} error={error('discount')} />
              </div>

              <div className="lg:col-span-1">
                <label className={labelClass} htmlFor={name('vatRate')}>
                  TVA (%)
                </label>
                <input
                  {...invalid('vatRate')}
                  value={line.vatRate}
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { vatRate: event.target.value })}
                  className={`${fieldClass} mt-1 tabular`}
                />
                <FieldError id={`${name('vatRate')}-error`} error={error('vatRate')} />
              </div>

              <div className="lg:col-span-2">
                <p className={labelClass}>Montant HT</p>
                <p className="mt-1 py-2 text-sm font-medium tabular-nums">
                  {amount ? money(lineNetAmountCents(amount)) : '—'}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {line.recurring === 'on' ? periodSuffix : 'une fois'}
                  </span>
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm" htmlFor={name('recurring')}>
                <input
                  id={name('recurring')}
                  name={name('recurring')}
                  type="checkbox"
                  value="on"
                  checked={line.recurring === 'on'}
                  onChange={(event) =>
                    update(line.key, { recurring: event.target.checked ? 'on' : '' })
                  }
                  className="size-4 accent-primary"
                />
                Due à chaque période
                <span className="text-xs text-muted-foreground">
                  (décochée : due une fois, comme des frais de dossier)
                </span>
              </label>
              <button
                type="button"
                onClick={() => remove(line.key)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Retirer la ligne {index + 1}
              </button>
            </div>
          </fieldset>
        )
      })}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <button
          ref={addButton}
          type="button"
          onClick={add}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Ajouter une ligne
        </button>

        <dl
          aria-live="polite"
          className="grid min-w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-lg border border-border bg-white px-4 py-3 text-sm"
        >
          <dt className="text-muted-foreground">Récurrent HT {periodSuffix}</dt>
          <dd className="text-right font-medium tabular-nums">{money(totals.recurringNetCents)}</dd>
          {totals.recurringVat.map((group) => (
            <div key={group.vatRateBp} className="contents">
              <dt className="text-muted-foreground">TVA {formatBpAsPercent(group.vatRateBp)} %</dt>
              <dd className="text-right tabular-nums">{money(group.vatCents)}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Récurrent TTC {periodSuffix}</dt>
          <dd className="text-right font-medium tabular-nums">{money(totals.recurringGrossCents)}</dd>
          {totals.oneOffNetCents > 0 && (
            <>
              <dt className="text-muted-foreground">Ponctuel HT, dû une fois</dt>
              <dd className="text-right tabular-nums">{money(totals.oneOffNetCents)}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  )
}

/** Libellés des champs de lignes pour le résumé d'erreurs : « Ligne 2 — Désignation ». */
export function lineErrorLabels(
  errors: Record<string, string>,
  lines: readonly LineFormValues[],
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const name of Object.keys(errors)) {
    const match = /^ligne-(.+)-([a-zA-Z]+)$/.exec(name)
    if (!match) continue
    const index = lines.findIndex((line) => line.key === match[1])
    const field = match[2] as LineField
    labels[name] = `Ligne ${index >= 0 ? index + 1 : '?'} — ${lineFieldLabels[field] ?? field}`
  }
  return labels
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}
