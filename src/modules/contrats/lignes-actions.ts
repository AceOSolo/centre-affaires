'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { readLinesForm } from './lignes.ts'
import { ContractLinesRefusedError, saveDraftContractLines } from './lignes-queries.ts'

/**
 * État rendu au formulaire de lignes : erreur générale, ou erreurs rattachées
 * à chaque champ par son nom (`ligne-3-description`), reprises par le résumé.
 * La saisie reste dans l'état du composant : rien à renvoyer.
 */
export type LinesFormState = {
  error?: string
  fieldErrors?: Record<string, string>
} | null

/**
 * Lignes de la version initiale d'un contrat brouillon (R12, ADR 025) : le
 * montant du contrat en découle, tenu par la base. Mêmes droits que la
 * modification d'un brouillon.
 */
export async function saveContractLinesAction(
  _previous: LinesFormState,
  formData: FormData,
): Promise<LinesFormState> {
  await requirePermission('contrats.creer')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  const keys = formData.getAll('ligne').map(String)
  const read = readLinesForm(keys, (name) => String(formData.get(name) ?? ''))
  if (!read.ok) return { fieldErrors: read.fieldErrors }

  try {
    if (!(await saveDraftContractLines(id, read.lines))) {
      return {
        error:
          'Ce contrat n’est plus un brouillon, ou il a été archivé : ses lignes changent désormais par avenant.',
      }
    }
  } catch (error) {
    if (error instanceof ContractLinesRefusedError) return { error: error.message }
    throw error
  }

  revalidatePath('/contrats')
  revalidatePath(`/contrats/${id}`)
  redirect(`/contrats/${id}?fait=lignes`)
}
