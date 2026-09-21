'use client'

import { useActionState } from 'react'
import { saveRequestPolicyAction } from './policy-actions.ts'
import type { RequestPolicy } from './request-policy.ts'

const field = 'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm'

export function RequestPolicyForm({ policy }: { policy: RequestPolicy }) {
  const [state, action, pending] = useActionState(saveRequestPolicyAction, null)
  return (
    <form action={action} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Ces délais s’appliquent aux demandes du site public. L’équipe peut toujours réserver depuis le planning admin.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium" htmlFor="bookingLeadHours">
          Préavis minimum (heures)
          <input className={field} id="bookingLeadHours" name="bookingLeadHours" type="number" min={0} max={8759} step={1} required defaultValue={policy.bookingLeadHours} />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">0 : sans préavis. 48 : au moins deux jours avant.</span>
        </label>
        <label className="text-sm font-medium" htmlFor="bookingHorizonDays">
          Réservation à l’avance (jours maximum)
          <input className={field} id="bookingHorizonDays" name="bookingHorizonDays" type="number" min={1} max={365} step={1} required defaultValue={policy.bookingHorizonDays} />
        </label>
      </div>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {state?.saved && <p role="status" className="text-sm text-primary">Délais enregistrés.</p>}
      <button disabled={pending} className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50">{pending ? 'Enregistrement…' : 'Enregistrer les délais'}</button>
    </form>
  )
}
