'use client'

import Form from 'next/form'
import { useFormStatus } from 'react-dom'

import { CalendarIcon } from '../../components/ui/icons.tsx'

type Props = {
  date: string
  minDate: string
  maxDate: string
  resourceId?: string
}

/** Actualise les données serveur en gardant la position dans la page. */
export function PublicAvailabilityDate({ resourceId, ...dates }: Props) {
  return (
    <Form action="/#disponibilites" replace scroll={false} className="flex flex-wrap items-center gap-3">
      {resourceId && <input type="hidden" name="espace" value={resourceId} />}
      <label htmlFor="disponibilites-date" className="flex items-center gap-2 text-sm font-medium text-primary">
        <CalendarIcon size={20} />
        Choisir un jour
      </label>
      <DateInput {...dates} />
      <noscript>
        <button type="submit" className="min-h-11 rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-background">
          Afficher
        </button>
      </noscript>
    </Form>
  )
}

function DateInput({ date, minDate, maxDate }: Omit<Props, 'resourceId'>) {
  const { pending } = useFormStatus()

  return (
    <>
      <input
        id="disponibilites-date"
        name="date"
        type="date"
        required
        min={minDate}
        max={maxDate}
        defaultValue={date}
        aria-describedby="disponibilites-date-status"
        onChange={(event) => {
          const input = event.currentTarget
          if (input.validity.valid && input.value) {
            input.form?.requestSubmit()
          }
        }}
        className="min-h-11 min-w-0 rounded-sm border border-border bg-background px-3 py-2 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
      />
      <span id="disponibilites-date-status" role="status" className="text-xs text-muted-foreground">
        {pending ? 'Actualisation des disponibilités…' : 'Mise à jour automatique'}
      </span>
    </>
  )
}
