'use server'

import { revalidatePath } from 'next/cache'

import { requireClientAccount } from '../clients/session.ts'
import { mergeShownPreferences } from './preferences-groupes.ts'
import { listMemberPreferences, saveMemberPreferences } from './queries.ts'

/**
 * Préférences de messages d'une personne de l'espace client (R26, ADR 038).
 * L'action revérifie le compte : une action serveur s'invoque par son
 * identifiant depuis n'importe quelle page (ADR 008). L'accès réglé est pris
 * parmi ceux du compte, jamais dans le formulaire.
 *
 * La page ne montre que les groupes des services utilisés (ADR 077) : seules
 * les cases montrées changent, les autres gardent leur réglage
 * (`mergeShownPreferences`).
 */
export type PreferencesFormState = { saved?: boolean; error?: string } | null

export async function savePreferencesAction(
  _previous: PreferencesFormState,
  formData: FormData,
): Promise<PreferencesFormState> {
  const { accounts } = await requireClientAccount()
  const clientId = String(formData.get('clientId') ?? '')
  const current = (await listMemberPreferences(accounts)).find((entry) => entry.account.clientId === clientId)
  if (!current) {
    return { error: 'Ces préférences ne peuvent pas être enregistrées : entreprise introuvable dans votre espace.' }
  }
  const enabled = mergeShownPreferences(current.enabled, formData)

  if (!(await saveMemberPreferences(accounts, clientId, enabled))) {
    return { error: 'Ces préférences ne peuvent pas être enregistrées : entreprise introuvable dans votre espace.' }
  }
  revalidatePath('/compte/preferences')
  return { saved: true }
}
