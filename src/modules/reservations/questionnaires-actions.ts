'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import {
  moveQuestion,
  putQuestion,
  questionFromForm,
  readQuestionForm,
  setQuestionHidden,
  type QuestionFormValues,
} from './questionnaires-edition.ts'
import {
  FORM_DESCRIPTION_MAX_LENGTH,
  FORM_LABEL_MAX_LENGTH,
  FormSettingsError,
  listOfferableServices,
  loadFormSettings,
  updateFormSettings,
} from './questionnaires-queries.ts'
import { defaultQuestionnaires, isFormulaire, type Formulaire } from './questionnaires.ts'

/**
 * Actions de l'écran « Formulaires de demande » (ADR 074). Chacune revérifie
 * le droit (`formulaires.gerer`, ADR 019) : une action serveur s'invoque par
 * son identifiant, depuis n'importe quelle page (ADR 008).
 */

const page = (form: Formulaire) => `/reglages/formulaires/${form}`

/** Ce que l'écran et le site relisent après un changement. */
function revalidate(form: Formulaire) {
  revalidatePath('/reglages/formulaires')
  revalidatePath(page(form))
  // La page publique, l'espace client et le back-office posent ces questions.
  revalidatePath('/', 'layout')
}

export type FormEditState = {
  ok?: string
  message?: string
  fieldErrors?: Record<string, string>
  /** La saisie renvoyée après un refus : React vide le formulaire à chaque envoi. */
  values?: QuestionFormValues
} | null

function formOf(formData: FormData): Formulaire | undefined {
  const value = String(formData.get('formulaire') ?? '')
  return isFormulaire(value) ? value : undefined
}

function refusal(error: unknown): string {
  if (error instanceof FormSettingsError) return error.message
  throw error
}

/** Le nom et la phrase du service, tels que le visiteur les choisit. */
export async function savePresentationAction(_previous: FormEditState, formData: FormData): Promise<FormEditState> {
  const { member } = await requirePermission('formulaires.gerer')
  const form = formOf(formData)
  if (!form) return { message: 'Ce formulaire n’existe pas.' }
  const label = String(formData.get('label') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const fieldErrors: Record<string, string> = {}
  if (!label) fieldErrors.label = 'Saisissez le nom du service.'
  else if (label.length > FORM_LABEL_MAX_LENGTH) fieldErrors.label = `${FORM_LABEL_MAX_LENGTH} caractères au plus.`
  if (!description) fieldErrors.description = 'Saisissez la phrase qui présente le service.'
  else if (description.length > FORM_DESCRIPTION_MAX_LENGTH) fieldErrors.description = `${FORM_DESCRIPTION_MAX_LENGTH} caractères au plus.`
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors }
  try {
    await updateFormSettings(form, () => ({ label, description }), member.id)
  } catch (error) {
    return { message: refusal(error) }
  }
  revalidate(form)
  return { ok: 'Présentation enregistrée.' }
}

/**
 * Ajoute une question, ou modifie celle que `nom` désigne. Le formulaire est
 * relu sous verrou : la question se juge au milieu des questions du moment.
 */
export async function saveQuestionAction(_previous: FormEditState, formData: FormData): Promise<FormEditState> {
  const { member } = await requirePermission('formulaires.gerer')
  const form = formOf(formData)
  if (!form) return { message: 'Ce formulaire n’existe pas.' }
  const name = String(formData.get('nom') ?? '')
  const current = await loadFormSettings(form)
  const existing = name ? current.questionnaire.questions.find((question) => question.name === name) : undefined
  if (name && !existing) return { message: 'Cette question n’existe plus : rouvrez le formulaire.' }
  const values = readQuestionForm(formData, existing)
  const first = questionFromForm(values, current.questionnaire.questions, existing)
  if (first.errors) return { fieldErrors: first.errors, values }
  try {
    await updateFormSettings(
      form,
      (settings) => {
        const fresh = name ? settings.questionnaire.questions.find((question) => question.name === name) : undefined
        if (name && !fresh) throw new FormSettingsError('Cette question n’existe plus : rouvrez le formulaire.')
        const result = questionFromForm(values, settings.questionnaire.questions, fresh)
        if (result.errors) throw new FormSettingsError(Object.values(result.errors)[0])
        return { questions: putQuestion(settings.questionnaire.questions, result.question) }
      },
      member.id,
    )
  } catch (error) {
    return { message: refusal(error), values }
  }
  revalidate(form)
  redirect(`${page(form)}?enregistre=${existing ? 'question' : 'ajout'}`)
}

/** Monter, descendre, masquer ou reposer une question, depuis la liste. */
export async function questionCommandAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('formulaires.gerer')
  const form = formOf(formData)
  if (!form) redirect('/reglages/formulaires')
  const name = String(formData.get('nom') ?? '')
  const command = String(formData.get('commande') ?? '')
  let notice = command
  try {
    await updateFormSettings(
      form,
      ({ questionnaire }) => {
        const { questions } = questionnaire
        if (!questions.some((question) => question.name === name)) throw new FormSettingsError('introuvable')
        if (command === 'monter' || command === 'descendre') {
          return { questions: moveQuestion(questions, name, command === 'monter' ? 'up' : 'down') }
        }
        if (command === 'masquer' || command === 'afficher') {
          return { questions: setQuestionHidden(questions, name, command === 'masquer') }
        }
        throw new FormSettingsError('commande')
      },
      member.id,
    )
  } catch (error) {
    if (!(error instanceof FormSettingsError)) throw error
    // Une condition passerait avant sa question : l'ordre est refusé.
    notice = 'ordre-refuse'
  }
  revalidate(form)
  redirect(`${page(form)}?enregistre=${notice}#questions`)
}

/** Les questions par défaut, celles du code ; le nom, la phrase et les options restent. */
export async function resetQuestionsAction(_previous: { error?: string } | null, formData: FormData): Promise<{ error?: string } | null> {
  const { member } = await requirePermission('formulaires.gerer')
  const form = formOf(formData)
  if (!form) return { error: 'Ce formulaire n’existe pas.' }
  try {
    await updateFormSettings(form, () => ({ questions: [...defaultQuestionnaires[form].questions] }), member.id)
  } catch (error) {
    return { error: refusal(error) }
  }
  revalidate(form)
  redirect(`${page(form)}?enregistre=defaut`)
}

/**
 * Les options que le formulaire de domiciliation propose : des forfaits
 * mensuels du catalogue, reçus de Dolibarr (ADR 049). Un code qui n'en est
 * pas un est refusé.
 */
export async function saveDomiciliationOptionsAction(_previous: FormEditState, formData: FormData): Promise<FormEditState> {
  const { member } = await requirePermission('formulaires.gerer')
  const offerable = await listOfferableServices()
  const codes = [...new Set(formData.getAll('services').map(String))]
  if (codes.some((code) => !offerable.some((service) => service.code === code))) {
    return { message: 'Un de ces services n’est plus au catalogue : rechargez la page.' }
  }
  // Dans l'ordre du catalogue, par nom.
  const ordered = offerable.map((service) => service.code).filter((code) => codes.includes(code))
  try {
    await updateFormSettings('domiciliation', () => ({ serviceCodes: ordered }), member.id)
  } catch (error) {
    return { message: refusal(error) }
  }
  revalidate('domiciliation')
  return { ok: ordered.length === 0 ? 'Aucune option proposée : le formulaire annonce le forfait seul.' : `${ordered.length} option(s) proposée(s).` }
}
