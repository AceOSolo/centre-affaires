'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { DocumentKeyError } from '../../lib/chiffrement-documents.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { notifyInspectionToSign } from '../notifications/declencheurs-etats-des-lieux.ts'
import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import {
  FIELD_ID_PATTERN,
  inspectionFieldsIssues,
  inspectionValuesIssues,
  normalizeEditorFields,
  readInspectionValues,
  valueInputName,
  type EditorField,
} from './champs.ts'
import { inspectionRefusalMessage } from './erreurs.ts'
import { readPhoto } from './photos.ts'
import {
  addInspectionPhoto,
  captionInspectionPhoto,
  createInspection,
  findInspection,
  publishTemplateVersion,
  removeInspectionPhoto,
  saveInspection,
  withdrawInspection,
  type CandidateContext,
} from './queries.ts'
import { inspectionKinds, type InspectionKind } from './schema.ts'

/**
 * Actions du back-office sur les états des lieux (R06, ADR 039). Chacune
 * vérifie son droit elle-même (ADR 008, 019) : `etats-des-lieux.modeles` pour
 * les modèles (exploitant), `etats-des-lieux.gerer` pour la saisie (accueil et
 * exploitant).
 */

/**
 * État rendu aux formulaires : un message général, les erreurs par champ
 * (clé = identifiant HTML du champ, pour le lien du résumé), et les saisies
 * brutes, que React efface après l'envoi.
 */
export type InspectionFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

/** Refus métier → message ; panne → remonte. */
function refusal(error: unknown): string {
  const message = inspectionRefusalMessage(error)
  if (message) return message
  throw error
}

/* -------------------------------------------------------------------------- */
/* Modèles                                                                    */
/* -------------------------------------------------------------------------- */

const isResourceType = (value: string): value is ResourceType =>
  (resourceTypes as readonly string[]).includes(value)

function parseEditorFields(raw: string): EditorField[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((row) => {
      const field = (row ?? {}) as Record<string, unknown>
      const string = (key: string) => (typeof field[key] === 'string' ? (field[key] as string) : '')
      return {
        id: string('id'),
        label: string('label'),
        type: string('type'),
        required: field.required === true,
        unit: string('unit'),
        options: string('options'),
        help: string('help'),
      }
    })
  } catch {
    return undefined
  }
}

/**
 * Publie le modèle d'un type : une nouvelle version si les champs changent.
 * Les états des lieux déjà saisis gardent la leur.
 */
export async function publishTemplateAction(
  _previous: InspectionFormState,
  formData: FormData,
): Promise<InspectionFormState> {
  const { member } = await requirePermission('etats-des-lieux.modeles')
  const type = text(formData, 'resourceType')
  if (!isResourceType(type)) return { error: 'Type de ressource inconnu.' }

  const name = text(formData, 'name')
  const rows = parseEditorFields(String(formData.get('fields') ?? ''))
  const fieldErrors: Record<string, string> = {}
  if (!name) fieldErrors.name = 'Donnez un nom au modèle.'
  else if (name.length > 200) fieldErrors.name = 'Le nom compte 200 caractères au plus.'
  if (!rows) return { error: 'Les champs du modèle n’ont pas pu être lus. Rechargez la page.' }

  const fields = normalizeEditorFields(rows)
  let general: string | undefined
  for (const issue of inspectionFieldsIssues(fields)) {
    if (issue.index === null) general = issue.message
    else fieldErrors[`champ-${issue.index}`] = issue.message
  }
  if (general || Object.keys(fieldErrors).length > 0) return { error: general, fieldErrors }

  let outcome
  try {
    outcome = await publishTemplateVersion({ resourceType: type, name, fields }, member.id)
  } catch (error) {
    return { error: refusal(error) }
  }

  revalidatePath('/etats-des-lieux/modeles')
  redirect(
    `/etats-des-lieux/modeles/${type}?fait=${outcome.status}${
      outcome.status === 'published' ? `&numero=${outcome.version}` : ''
    }`,
  )
}

/* -------------------------------------------------------------------------- */
/* Création                                                                   */
/* -------------------------------------------------------------------------- */

const contextKinds = ['booking', 'contract', 'resource'] as const

export async function createInspectionAction(
  _previous: InspectionFormState,
  formData: FormData,
): Promise<InspectionFormState> {
  const { member } = await requirePermission('etats-des-lieux.gerer')
  const timeZone = await currentTimeZone()

  const contextKind = text(formData, 'contextKind')
  const contextId = text(formData, 'contextId')
  if (!(contextKinds as readonly string[]).includes(contextKind) || !isUuid(contextId)) {
    return { error: 'Point de départ inconnu : repartez de la fiche de la ressource, de la réservation ou du contrat.' }
  }
  const context = { kind: contextKind, id: contextId } as CandidateContext

  const values = {
    candidate: text(formData, 'candidate'),
    kind: text(formData, 'kind'),
    entry: text(formData, 'entry'),
    performedAt: text(formData, 'performedAt'),
  }
  const fieldErrors: Record<string, string> = {}
  if (!values.candidate) fieldErrors.candidate = 'Choisissez l’occupation concernée.'
  if (!(inspectionKinds as readonly string[]).includes(values.kind)) {
    fieldErrors.kind = 'Choisissez entrée ou sortie.'
  }
  let performedAt: Date | undefined
  try {
    performedAt = wallClockToUtc(values.performedAt, timeZone)
  } catch {
    fieldErrors.performedAt = 'Indiquez la date et l’heure de l’état des lieux.'
  }
  if (values.entry && !isUuid(values.entry)) fieldErrors.entry = 'État des lieux d’entrée inconnu.'
  if (Object.keys(fieldErrors).length > 0 || !performedAt) return { fieldErrors, values }

  let id: string
  try {
    id = await createInspection(
      {
        context,
        candidateKey: values.candidate,
        kind: values.kind as InspectionKind,
        entryInspectionId: values.kind === 'exit' && values.entry ? values.entry : null,
        performedAt,
      },
      member.id,
    )
  } catch (error) {
    return { error: refusal(error), values }
  }

  revalidatePath('/etats-des-lieux')
  redirect(`/etats-des-lieux/${id}?fait=cree`)
}

/* -------------------------------------------------------------------------- */
/* Saisie et clôture                                                          */
/* -------------------------------------------------------------------------- */

/** Observations générales : un état des lieux, pas un roman. */
const MAX_OBSERVATIONS = 10_000

/**
 * Enregistre le brouillon, ou le clôt (`intent=close`). Une clôture refusée
 * enregistre tout de même la saisie en brouillon : rien n'est perdu, et la
 * liste de ce qui manque s'affiche en tête.
 */
export async function saveInspectionAction(
  _previous: InspectionFormState,
  formData: FormData,
): Promise<InspectionFormState> {
  const { member } = await requirePermission('etats-des-lieux.gerer')
  const id = text(formData, 'id')
  const inspection = isUuid(id) ? await findInspection(id) : undefined
  if (!inspection) return { error: 'État des lieux introuvable.' }
  if (inspection.status !== 'draft' || inspection.deletedAt) {
    return { error: 'Cet état des lieux est clos ou retiré : il ne se modifie plus.' }
  }

  const fields = inspection.template.fields
  const close = formData.get('intent') === 'close'
  const raw: Record<string, string> = {}
  for (const field of fields) raw[valueInputName(field.id)] = String(formData.get(valueInputName(field.id)) ?? '')
  raw.performedAt = text(formData, 'performedAt')
  raw.observations = String(formData.get('observations') ?? '')

  const fieldErrors: Record<string, string> = {}
  const { values, errors } = readInspectionValues(fields, (name) => raw[name])
  for (const [fieldId, message] of Object.entries(errors)) fieldErrors[valueInputName(fieldId)] = message

  const timeZone = await currentTimeZone()
  let performedAt: Date | undefined
  try {
    performedAt = wallClockToUtc(raw.performedAt, timeZone)
  } catch {
    fieldErrors.performedAt = 'Indiquez la date et l’heure de l’état des lieux.'
  }
  const observations = raw.observations.trim()
  if (observations.length > MAX_OBSERVATIONS) {
    fieldErrors.observations = 'Les observations comptent 10 000 caractères au plus.'
  }
  if (Object.keys(fieldErrors).length > 0 || !performedAt) {
    return {
      error: close ? 'Rien n’a été enregistré : corrigez la saisie avant de clore.' : undefined,
      fieldErrors,
      values: raw,
    }
  }

  const input = { values, observations: observations || null, performedAt }

  if (close) {
    const missing: Record<string, string> = {}
    for (const issue of inspectionValuesIssues(fields, values, true)) {
      if (issue.fieldId) missing[valueInputName(issue.fieldId)] = issue.message
    }
    if (performedAt.getTime() > Date.now() + 5 * 60_000) {
      missing.performedAt = 'Un état des lieux se clôt une fois fait : sa date ne peut pas être à venir.'
    }
    if (formData.get('confirmClose') !== 'on') {
      missing.confirmClose = 'Cochez la confirmation : la clôture fige l’état des lieux.'
    }
    if (Object.keys(missing).length > 0) {
      try {
        await saveInspection(id, input, null)
      } catch (error) {
        return { error: refusal(error), values: raw }
      }
      revalidatePath(`/etats-des-lieux/${id}`)
      return {
        error: 'Saisie enregistrée en brouillon, mais l’état des lieux n’est pas clos : complétez ce qui manque.',
        fieldErrors: missing,
        values: raw,
      }
    }
  }

  try {
    await saveInspection(id, input, close ? member.id : null)
  } catch (error) {
    return { error: refusal(error), values: raw }
  }
  // Clos : le client est invité à le valider (`inspection_to_sign`, ADR 038),
  // après la réponse ; le message ne contient ni le relevé ni les photos.
  if (close) after(() => notifyInspectionToSign(id))

  revalidatePath('/etats-des-lieux')
  revalidatePath(`/etats-des-lieux/${id}`)
  redirect(`/etats-des-lieux/${id}?fait=${close ? 'clos' : 'enregistre'}`)
}

/** Retire un brouillon saisi par erreur (`ConfirmDialog`). */
export async function withdrawInspectionAction(
  _previous: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string } | null> {
  await requirePermission('etats-des-lieux.gerer')
  const id = text(formData, 'id')
  if (!isUuid(id)) return { error: 'État des lieux introuvable.' }
  try {
    await withdrawInspection(id)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidatePath('/etats-des-lieux')
  redirect('/etats-des-lieux?fait=retire')
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

export type PhotoActionResult = { error?: string }

const MAX_CAPTION = 500

/**
 * Dépôt d'une photo, déjà compressée par le navigateur : le serveur vérifie
 * le type et la taille dans les octets, chiffre, dépose, inscrit.
 */
export async function uploadInspectionPhotoAction(formData: FormData): Promise<PhotoActionResult> {
  const { member } = await requirePermission('etats-des-lieux.gerer')
  const inspectionId = text(formData, 'inspectionId')
  if (!isUuid(inspectionId)) return { error: 'État des lieux introuvable.' }
  const fieldId = text(formData, 'fieldId') || null
  if (fieldId && !FIELD_ID_PATTERN.test(fieldId)) return { error: 'Champ inconnu.' }
  const caption = text(formData, 'caption').slice(0, MAX_CAPTION) || null

  const { photo, error } = await readPhoto(formData.get('photo'))
  if (!photo) return { error }

  try {
    await addInspectionPhoto(inspectionId, { fieldId, caption, photo }, member.id)
  } catch (failure) {
    const message = inspectionRefusalMessage(failure)
    if (message) return { error: message }
    console.error('Dépôt de photo d’état des lieux impossible', failure)
    if (failure instanceof DocumentKeyError) {
      return {
        error:
          'La photo n’a pas été déposée : le chiffrement des documents n’est pas configuré sur ce serveur. Prévenez la personne qui administre l’application.',
      }
    }
    return {
      error: 'La photo n’a pas pu être déposée. Réessayez ; si le problème persiste, le stockage est peut-être indisponible.',
    }
  }
  revalidatePath(`/etats-des-lieux/${inspectionId}`)
  return {}
}

export async function captionInspectionPhotoAction(
  inspectionId: string,
  photoId: string,
  caption: string,
): Promise<PhotoActionResult> {
  await requirePermission('etats-des-lieux.gerer')
  if (!isUuid(inspectionId) || !isUuid(photoId)) return { error: 'Photo introuvable.' }
  const value = caption.trim()
  if (value.length > MAX_CAPTION) return { error: 'La légende compte 500 caractères au plus.' }
  try {
    await captionInspectionPhoto(photoId, value || null)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidatePath(`/etats-des-lieux/${inspectionId}`)
  return {}
}

export async function removeInspectionPhotoAction(
  inspectionId: string,
  photoId: string,
): Promise<PhotoActionResult> {
  await requirePermission('etats-des-lieux.gerer')
  if (!isUuid(inspectionId) || !isUuid(photoId)) return { error: 'Photo introuvable.' }
  try {
    await removeInspectionPhoto(photoId)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidatePath(`/etats-des-lieux/${inspectionId}`)
  return {}
}
