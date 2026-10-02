'use client'

import { useId } from 'react'

import { onRequestBases, onRequestBasisLabels } from './fondement.ts'

/**
 * Fondement d'une anonymisation à la demande, dans son dialogue de
 * confirmation (ADR 041) : demande d'effacement, datée du jour où elle a été
 * reçue, ou fin de la relation. La base le trace avec l'auteur ; un oubli est
 * refusé et dit dans le dialogue.
 */
export function AnonymizationBasisFields({ today }: { today: string }) {
  const id = useId()
  const dateId = `${id}-date`
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border px-4 py-3">
      <legend className="px-1 text-sm font-medium">Fondement</legend>
      {onRequestBases.map((basis) => (
        <label key={basis} className="flex items-start gap-2">
          <input type="radio" name="basis" value={basis} required className="mt-1" />
          <span>{onRequestBasisLabels[basis]}</span>
        </label>
      ))}
      <div className="flex flex-col gap-1 pl-6">
        <label htmlFor={dateId} className="text-sm font-medium">
          Demande d’effacement reçue le
        </label>
        <input
          id={dateId}
          type="date"
          name="erasureRequestedOn"
          max={today}
          aria-describedby={`${dateId}-aide`}
          className="w-44 rounded-sm border border-border bg-white px-3 py-2 text-sm"
        />
        <p id={`${dateId}-aide`} className="text-xs text-muted-foreground">
          Obligatoire pour une demande d’effacement : le centre a un mois pour y répondre.
        </p>
      </div>
    </fieldset>
  )
}
