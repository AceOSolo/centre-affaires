import { eventVariables, type TemplateVariable } from './catalogue.ts'
import type { NotificationEvent } from './schema.ts'

/**
 * Rendu et vérification des modèles de messages (R26, ADR 038).
 *
 * Un modèle cite des variables nommées entre doubles accolades : `{{client}}`,
 * `{{ lien }}`. Module pur, partagé par l'éditeur (aperçu dans le navigateur),
 * l'action qui enregistre (vérification) et le moteur qui envoie (rendu).
 *
 * Les messages partent en texte brut : il n'y a pas de HTML à échapper. Les
 * valeurs sont en revanche insérées telles quelles, en une seule passe — une
 * valeur qui contient elle-même `{{…}}` (un nom de société saisi ainsi, un
 * motif) n'est jamais réinterprétée comme une variable — et nettoyées de leurs
 * caractères de contrôle ; dans l'objet, elles tiennent sur une ligne.
 */

/** Longueurs maximales, celles que la base vérifie (`notification_templates_text_valid`). */
export const TEMPLATE_SUBJECT_MAX = 200
export const TEMPLATE_BODY_MAX = 10_000

/** Valeurs d'un message : absente, nulle ou vide, une variable « manque ». */
export type TemplateValues = Readonly<Record<string, string | null | undefined>>

/** `{{ nom }}` : le nom, sans les espaces autour. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g
const VARIABLE_NAME = /^[a-z][a-z_]*$/

/** Caractères de contrôle, sauf la tabulation et le saut de ligne. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

function presentValue(values: TemplateValues, name: string): string | undefined {
  const value = values[name]
  if (value === null || value === undefined) return undefined
  const cleaned = value.replace(/\r\n?/g, '\n').replace(CONTROL, '')
  return cleaned.trim() === '' ? undefined : cleaned
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Noms des variables citées par un texte, dans l'ordre, sans doublon. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))]
}

/**
 * Objet rendu : sur une ligne, sans espace en trop. Une variable manquante y
 * est remplacée par rien.
 */
export function renderSubject(subject: string, values: TemplateValues): string {
  const rendered = subject.replace(PLACEHOLDER, (_match, name: string) => {
    const value = presentValue(values, name)
    return value === undefined ? '' : oneLine(value)
  })
  return oneLine(rendered.replace(CONTROL, ''))
}

/**
 * Corps rendu. Une ligne qui cite une variable manquante n'est pas envoyée :
 * « Votre boîte aux lettres : {{lien}} » disparaît quand l'adresse de
 * l'application n'est pas configurée, plutôt que de partir à moitié vide. Les
 * lignes vides qui se suivent alors sont réduites à une.
 */
export function renderBody(body: string, values: TemplateValues): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const names = [...line.matchAll(PLACEHOLDER)].map((match) => match[1])
    if (names.some((name) => presentValue(values, name) === undefined)) continue
    kept.push(
      line.replace(PLACEHOLDER, (_match, name: string) => presentValue(values, name) as string),
    )
  }
  return kept
    .join('\n')
    .replace(CONTROL, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim()
}

export type TemplateField = 'subject' | 'body'
export type TemplateErrors = Partial<Record<TemplateField, string>>

function describeVariables(variables: readonly TemplateVariable[]): string {
  return variables.map((variable) => `{{${variable.name}}}`).join(', ')
}

/** Ce qui ne va pas dans un texte de modèle : accolades, variables inconnues. */
function placeholderError(text: string, variables: readonly TemplateVariable[]): string | undefined {
  // Ce qui reste une fois les variables bien formées retirées ne doit plus
  // contenir d'accolade double : `{{client}` ou `{client}}` est une faute de
  // frappe, qui partirait telle quelle chez le client.
  const rest = text.replace(PLACEHOLDER, '')
  if (rest.includes('{{') || rest.includes('}}')) {
    return 'Accolades mal fermées : écrivez chaque variable sous la forme {{nom}}.'
  }
  const known = new Set(variables.map((variable) => variable.name))
  const unknown = placeholdersOf(text).filter((name) => !VARIABLE_NAME.test(name) || !known.has(name))
  if (unknown.length > 0) {
    const cited = unknown.map((name) => `{{${name}}}`).join(', ')
    return `${unknown.length > 1 ? 'Variables inconnues' : 'Variable inconnue'} pour ce message : ${cited}. ` +
      `Variables possibles : ${describeVariables(variables)}.`
  }
  return undefined
}

/**
 * Vérifie un modèle avant de l'enregistrer : longueurs de la base, objet sur
 * une ligne, accolades bien formées, variables connues de l'événement. Rend
 * les erreurs par champ, vides quand le modèle est bon.
 */
export function validateTemplate(
  event: NotificationEvent,
  template: { subject: string; body: string },
): TemplateErrors {
  const variables = eventVariables[event]
  const errors: TemplateErrors = {}

  const subject = template.subject
  if (subject.trim() === '') errors.subject = 'Saisissez l’objet du message.'
  else if (subject.length > TEMPLATE_SUBJECT_MAX) {
    errors.subject = `L’objet dépasse ${TEMPLATE_SUBJECT_MAX} caractères (${subject.length}).`
  } else if (/[\r\n]/.test(subject)) errors.subject = 'L’objet tient sur une seule ligne.'
  else {
    const problem = placeholderError(subject, variables)
    if (problem) errors.subject = problem
  }

  const body = template.body
  if (body.trim() === '') errors.body = 'Saisissez le texte du message.'
  else if (body.length > TEMPLATE_BODY_MAX) {
    errors.body = `Le texte dépasse ${TEMPLATE_BODY_MAX.toLocaleString('fr-FR')} caractères (${body.length.toLocaleString('fr-FR')}).`
  } else {
    const problem = placeholderError(body, variables)
    if (problem) errors.body = problem
  }
  return errors
}

/** Valeurs d'exemple de l'événement : celles de l'aperçu de l'éditeur. */
export function exampleValues(event: NotificationEvent): Record<string, string> {
  return Object.fromEntries(eventVariables[event].map((variable) => [variable.name, variable.example]))
}

export type RenderedMessage = { subject: string; body: string }

/**
 * Rend un message complet. Un objet vidé par des variables manquantes est
 * remplacé par `fallbackSubject` : la base refuse un objet vide, et un
 * message sans objet ne se reconnaît pas.
 */
export function renderMessage(
  template: { subject: string; body: string },
  values: TemplateValues,
  fallbackSubject: string,
): RenderedMessage {
  const subject = renderSubject(template.subject, values) || oneLine(fallbackSubject)
  return {
    subject: subject.length > TEMPLATE_SUBJECT_MAX ? `${subject.slice(0, TEMPLATE_SUBJECT_MAX - 1)}…` : subject,
    body: renderBody(template.body, values),
  }
}
