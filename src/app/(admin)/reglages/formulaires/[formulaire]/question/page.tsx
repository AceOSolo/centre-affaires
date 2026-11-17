import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ArrowLeftIcon } from '../../../../../../components/ui/icons.tsx'
import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { QuestionForm } from '../../../../../../modules/reservations/questionnaire-editor.tsx'
import { loadFormSettings } from '../../../../../../modules/reservations/questionnaires-queries.ts'
import { isFormulaire } from '../../../../../../modules/reservations/questionnaires.ts'

export const metadata = { title: 'Question d’un formulaire' }

/**
 * Ajouter une question au formulaire, ou modifier celle que `?nom=` désigne
 * (ADR 074) : libellé, type, aide, obligatoire, choix et « Autre », bornes,
 * condition d'affichage.
 */
export default async function QuestionPage({
  params,
  searchParams,
}: {
  params: Promise<{ formulaire: string }>
  searchParams: Promise<{ nom?: string }>
}) {
  await requirePermission('formulaires.gerer')
  const [{ formulaire }, { nom }] = await Promise.all([params, searchParams])
  if (!isFormulaire(formulaire)) notFound()
  const { questionnaire } = await loadFormSettings(formulaire)
  const question = nom ? questionnaire.questions.find((candidate) => candidate.name === nom) : undefined
  if (nom && !question) notFound()

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href={`/reglages/formulaires/${formulaire}`}
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon size={20} />
          Formulaire « {questionnaire.label} »
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{question ? 'Modifier une question' : 'Ajouter une question'}</h1>
        {question?.hidden && (
          <p className="mt-1 text-sm text-muted-foreground">Cette question est masquée : elle n’est pas posée tant qu’elle n’est pas reposée depuis la liste.</p>
        )}
      </div>
      <div className="rounded-lg border border-border bg-white px-5 py-4">
        <QuestionForm form={formulaire} question={question} questions={questionnaire.questions} />
      </div>
    </div>
  )
}
