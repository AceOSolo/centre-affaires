import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { ArrowLeftIcon } from '../../../../../components/ui/icons.tsx'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { formatCents } from '../../../../../modules/facturation/tarifs.ts'
import {
  DomiciliationOptionsForm,
  PresentationForm,
  ResetQuestionsButton,
} from '../../../../../modules/reservations/questionnaire-editor.tsx'
import { questionCommandAction } from '../../../../../modules/reservations/questionnaires-actions.ts'
import { describeCondition, neverShown } from '../../../../../modules/reservations/questionnaires-edition.ts'
import {
  listOfferableServices,
  loadDomiciliationOffer,
  loadFormSettings,
} from '../../../../../modules/reservations/questionnaires-queries.ts'
import { isFormulaire, questionKindLabels, type Question } from '../../../../../modules/reservations/questionnaires.ts'

export const metadata = { title: 'Formulaire de demande' }

const notices = new Map([
  ['question', 'Question enregistrée.'],
  ['ajout', 'Question ajoutée, à la fin du formulaire.'],
  ['monter', 'Ordre enregistré.'],
  ['descendre', 'Ordre enregistré.'],
  ['masquer', 'Question masquée : elle n’est plus posée. Les devis reçus gardent leurs réponses.'],
  ['afficher', 'Question de nouveau posée.'],
  ['defaut', 'Questions par défaut rétablies.'],
])

const linkClass =
  'inline-flex min-h-6 items-center text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const commandClass =
  'min-h-6 rounded-sm px-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline'
const section = 'flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4'

/**
 * Un formulaire de demande (ADR 074) : sa présentation, ses questions —
 * ajouter, modifier, ordonner, masquer —, et pour la domiciliation les options
 * tarifées. Les questions masquées restent listées : leurs réponses passées
 * restent lisibles, et elles se reposent d'un clic.
 */
export default async function FormulairePage({
  params,
  searchParams,
}: {
  params: Promise<{ formulaire: string }>
  searchParams: Promise<{ enregistre?: string }>
}) {
  await requirePermission('formulaires.gerer')
  const [{ formulaire }, { enregistre }, timeZone] = await Promise.all([params, searchParams, currentTimeZone()])
  if (!isFormulaire(formulaire)) notFound()
  const settings = await loadFormSettings(formulaire)
  const { questionnaire } = settings
  const questions = questionnaire.questions
  const never = neverShown(questions)
  const isDomiciliation = formulaire === 'domiciliation'
  const [offer, offerable] = isDomiciliation
    ? await Promise.all([loadDomiciliationOffer(settings.serviceCodes), listOfferableServices()])
    : [undefined, []]
  const notice = enregistre ? notices.get(enregistre) : undefined

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/reglages/formulaires" className={`${linkClass} gap-1.5 font-normal`}>
          <ArrowLeftIcon size={20} />
          Formulaires de demande
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Formulaire « {questionnaire.label} »</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          {settings.customized
            ? `Réglé par le centre${settings.updatedAt ? `, modifié le ${formatDateTime(settings.updatedAt, timeZone)}` : ''}.`
            : 'Questions par défaut : rien n’a encore été changé.'}{' '}
          Les questions valent pour le site, l’espace client et le devis établi par l’accueil.
        </p>
      </div>

      {notice && <FlashNotice key={enregistre}>{notice}</FlashNotice>}
      {enregistre === 'ordre-refuse' && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Une question qui ne s’affiche que selon une autre reste après elle : l’ordre n’a pas changé.
        </p>
      )}

      <section aria-labelledby="presentation-titre" className={section}>
        <h2 id="presentation-titre" className="text-lg font-semibold tracking-tight">Présentation</h2>
        <PresentationForm form={formulaire} label={questionnaire.label} description={questionnaire.description} />
      </section>

      <section id="questions" aria-labelledby="questions-titre" className={section}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="questions-titre" className="text-lg font-semibold tracking-tight">Questions</h2>
          <Link href={`/reglages/formulaires/${formulaire}/question`} className={linkClass}>Ajouter une question</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Questions du formulaire, dans l’ordre où elles sont posées</caption>
            <thead className="bg-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium tabular">N°</th>
                <th scope="col" className="px-3 py-2 font-medium">Question</th>
                <th scope="col" className="px-3 py-2 font-medium">Réponse</th>
                <th scope="col" className="px-3 py-2 font-medium">Obligatoire</th>
                <th scope="col" className="px-3 py-2 font-medium">Affichage</th>
                <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {questions.map((question, index) => (
                <tr key={question.name} className={`border-t border-border align-top ${question.hidden ? 'text-muted-foreground' : ''}`}>
                  <td className="px-3 py-2 tabular">{index + 1}</td>
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {question.label}
                    {question.hint && <span className="block text-xs font-normal text-muted-foreground">{question.hint}</span>}
                  </th>
                  <td className="px-3 py-2">{answerSummary(question)}</td>
                  <td className="px-3 py-2">{question.required ? 'Oui' : 'Non'}</td>
                  <td className="px-3 py-2">
                    {question.hidden
                      ? 'Masquée'
                      : never.has(question.name)
                        ? 'Jamais affichée : la question dont elle dépend est masquée'
                        : (describeCondition(question, questions) ?? 'Toujours')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Link
                        href={`/reglages/formulaires/${formulaire}/question?nom=${question.name}`}
                        aria-label={`Modifier « ${question.label} »`}
                        className={linkClass}
                      >
                        Modifier
                      </Link>
                      <form action={questionCommandAction} className="contents">
                        <input type="hidden" name="formulaire" value={formulaire} />
                        <input type="hidden" name="nom" value={question.name} />
                        <button type="submit" name="commande" value="monter" disabled={index === 0} aria-label={`Monter « ${question.label} »`} className={commandClass}>Monter</button>
                        <button type="submit" name="commande" value="descendre" disabled={index === questions.length - 1} aria-label={`Descendre « ${question.label} »`} className={commandClass}>Descendre</button>
                        <button type="submit" name="commande" value={question.hidden ? 'afficher' : 'masquer'} aria-label={`${question.hidden ? 'Poser de nouveau' : 'Masquer'} « ${question.label} »`} className={commandClass}>
                          {question.hidden ? 'Poser de nouveau' : 'Masquer'}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Une question n’est jamais supprimée : masquée, elle n’est plus posée, et les devis déjà reçus la gardent.
        </p>
      </section>

      {isDomiciliation && offer && (
        <section aria-labelledby="options-titre" className={section}>
          <h2 id="options-titre" className="text-lg font-semibold tracking-tight">Options et tarif</h2>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            Le formulaire affiche le total mensuel, HT et TTC, du forfait et des options cochées par le demandeur, et
            le devis en reprend les lignes. Les prix viennent de Dolibarr.
          </p>
          <p className="text-sm">
            <span className="font-medium">Forfait : </span>
            {offer.base ? (
              <span className="tabular">{formatCents(offer.base.amountCents, offer.currency)} HT par mois</span>
            ) : (
              <span>
                aucun prix au mois pour la boîte aux lettres dans la grille du jour : le formulaire dira « tarif
                communiqué par l’accueil ».
              </span>
            )}{' '}
            <span className="text-muted-foreground">
              (référence Dolibarr <span className="tabular">tarif.boite_aux_lettres.month</span>, visible à l’écran{' '}
              <Link href="/tarifs" className="text-primary underline-offset-2 hover:underline">Tarifs</Link>)
            </span>
          </p>
          <h3 className="text-sm font-semibold">Options proposées</h3>
          <DomiciliationOptionsForm
            services={offerable.map((service) => ({ code: service.code, name: service.name, description: service.description, unitPriceCents: service.unitPriceCents, currency: service.currency }))}
            selected={settings.serviceCodes}
          />
        </section>
      )}

      <section aria-labelledby="defaut-titre" className={section}>
        <h2 id="defaut-titre" className="text-lg font-semibold tracking-tight">Questions par défaut</h2>
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          Pour repartir des questions d’origine, celles du logiciel. Les devis déjà reçus ne changent pas.
        </p>
        <div><ResetQuestionsButton form={formulaire} /></div>
      </section>
    </div>
  )
}

/** « Choix unique : 5 choix, et Autre » */
function answerSummary(question: Question): string {
  const kind = questionKindLabels[question.kind]
  if (question.kind === 'choice' || question.kind === 'multi') {
    const count = question.choices?.length ?? 0
    return `${kind} : ${count} choix${question.allowOther ? ', et « Autre »' : ''}`
  }
  if (question.kind === 'integer' && (question.min !== undefined || question.max !== undefined)) {
    return `${kind}, de ${question.min ?? '…'} à ${question.max ?? '…'}`
  }
  return kind
}
