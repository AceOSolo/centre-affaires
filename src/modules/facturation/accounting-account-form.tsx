'use client'

import { useActionState } from 'react'

import { updateAccountAction, type AccountFormState } from './comptabilite-actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Une ligne du plan de comptes, modifiable en place. Le formulaire est dans la
 * dernière cellule ; les champs des autres cellules s'y rattachent par
 * l'attribut `form` — une ligne de tableau ne peut pas contenir un `<form>`.
 */
export function AccountingAccountRow({
  id,
  role,
  accountNumber,
  label,
}: {
  id: string
  /** Ce que le compte reçoit : « Ventes : loyers », « TVA collectée à 20 % ». */
  role: string
  accountNumber: string
  label: string
}) {
  const [state, formAction, pending] = useActionState<AccountFormState, FormData>(updateAccountAction, null)
  const formId = `compte-${id}`
  const numberId = `${formId}-numero`
  const labelId = `${formId}-libelle`
  const messageId = `${formId}-message`

  return (
    <tr>
      <th scope="row" className="px-4 py-2 text-left font-normal">
        {role}
      </th>
      <td className="px-4 py-2">
        <label htmlFor={numberId} className="sr-only">
          Numéro du compte {role}
        </label>
        <input
          id={numberId}
          form={formId}
          name="accountNumber"
          defaultValue={accountNumber}
          maxLength={20}
          spellCheck={false}
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={messageId}
          className={`${fieldClass} w-32 tabular`}
        />
      </td>
      <td className="px-4 py-2">
        <label htmlFor={labelId} className="sr-only">
          Libellé du compte {role}
        </label>
        <input
          id={labelId}
          form={formId}
          name="label"
          defaultValue={label}
          maxLength={120}
          aria-describedby={messageId}
          className={fieldClass}
        />
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right">
        <form id={formId} action={formAction} className="inline-flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            disabled={pending}
            aria-label={`Enregistrer le compte ${role}`}
            className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </form>
        <span id={messageId} aria-live="polite" className="block text-xs">
          {state?.error ? (
            <span className="text-destructive">{state.error}</span>
          ) : state?.saved ? (
            <span className="text-muted-foreground">Enregistré.</span>
          ) : null}
        </span>
      </td>
    </tr>
  )
}
