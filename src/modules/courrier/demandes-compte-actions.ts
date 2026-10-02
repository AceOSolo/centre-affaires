'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import {
  cancelMailRequest,
  previousForwardAddresses,
  requestForward,
  requestScan,
} from './demandes-queries.ts'
import { forwardAddressFieldLabels, readClientNote, readForwardAddress } from './demandes-regles.ts'
import { notifyMailRequestSubmitted } from './notifications-demandes.ts'

/**
 * Demandes déposées et annulées depuis l'espace client (R21, R24, ADR 037).
 * Chaque action revérifie le compte : une action serveur s'invoque par son
 * identifiant depuis n'importe quelle page (ADR 008). Les écritures passent
 * par la portée client (`inClientSpace`, ADR 019).
 *
 * Succès : retour au pli, avec une confirmation annoncée (`?fait=`). Échec :
 * l'état rendu au formulaire, le message de la base compris.
 */
export type ClientRequestState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Valeurs saisies, rendues au formulaire : React le réinitialise après l'envoi. */
  values?: Record<string, string>
} | null

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

function refresh() {
  revalidatePath('/compte/courrier', 'layout')
  // La file de l'accueil et le compteur de la navigation du back-office.
  revalidatePath('/courrier', 'layout')
}

export async function requestScanAction(
  _previous: ClientRequestState,
  formData: FormData,
): Promise<ClientRequestState> {
  const { accounts } = await requireClientAccount()
  const id = text(formData, 'id')
  const values = { scanNote: text(formData, 'scanNote') }
  const note = readClientNote(values.scanNote)
  if (note.error !== undefined) return { fieldErrors: { scanNote: note.error }, values }

  const outcome = await requestScan(id, accounts, note.value)
  if (!outcome.ok) return { error: outcome.error, values }
  after(() => notifyMailRequestSubmitted(outcome.requestId))
  refresh()
  redirect(`/compte/courrier/${id}?fait=numerisation`)
}

export async function requestForwardAction(
  _previous: ClientRequestState,
  formData: FormData,
): Promise<ClientRequestState> {
  const { accounts } = await requireClientAccount()
  const id = text(formData, 'id')
  const clientId = text(formData, 'clientId')
  const values: Record<string, string> = {
    adresse: text(formData, 'adresse'),
    forwardNote: text(formData, 'forwardNote'),
  }
  for (const field of Object.keys(forwardAddressFieldLabels)) values[field] = String(formData.get(field) ?? '')

  const fieldErrors: Record<string, string> = {}
  const note = readClientNote(values.forwardNote)
  if (note.error !== undefined) fieldErrors.forwardNote = note.error

  // Une adresse déjà utilisée par l'entreprise, relue en base, ou une saisie.
  let address
  if (values.adresse && values.adresse !== 'nouvelle') {
    const previous = await previousForwardAddresses(accounts, clientId)
    address = previous.find((candidate) => candidate.requestId === values.adresse)?.address
    if (!address) fieldErrors.adresse = 'Cette adresse n’est plus proposée : choisissez-en une autre.'
  } else {
    const read = readForwardAddress(values)
    if (read.fieldErrors) Object.assign(fieldErrors, read.fieldErrors)
    address = read.address
  }
  if (Object.keys(fieldErrors).length > 0 || !address || note.error !== undefined) {
    return { fieldErrors, values }
  }

  const outcome = await requestForward(id, accounts, address, note.value)
  if (!outcome.ok) return { error: outcome.error, values }
  after(() => notifyMailRequestSubmitted(outcome.requestId))
  refresh()
  redirect(`/compte/courrier/${id}?fait=reexpedition`)
}

/** Annulation tracée : la demande reste dans l'historique, au nom de la personne. */
export async function cancelMailRequestAction(
  _previous: ClientRequestState,
  formData: FormData,
): Promise<ClientRequestState> {
  const { accounts } = await requireClientAccount()
  const id = text(formData, 'id')
  const outcome = await cancelMailRequest(id, accounts)
  if (!outcome.ok) return { error: outcome.error }
  refresh()
  const mailItemId = text(formData, 'mailItemId')
  redirect(
    text(formData, 'retour') === 'demandes' || !isUuid(mailItemId)
      ? '/compte/courrier/demandes?fait=annulation'
      : `/compte/courrier/${mailItemId}?fait=annulation`,
  )
}
