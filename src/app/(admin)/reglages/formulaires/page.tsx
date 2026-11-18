import Link from 'next/link'

import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { loadAllFormSettings } from '../../../../modules/reservations/questionnaires-queries.ts'
import { askedQuestions, formulaires } from '../../../../modules/reservations/questionnaires.ts'

export const metadata = { title: 'Formulaires de demande' }

/**
 * « Formulaires de demande » (ADR 074) : un formulaire par service vendu —
 * salle, bureau, camion, matériel, domiciliation —, chacun avec ses questions,
 * réglées par le centre. Tant que le centre n'y touche pas, ce sont celles du
 * code.
 */
export default async function FormulairesPage() {
  await requirePermission('formulaires.gerer')
  const settings = await loadAllFormSettings()

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <LienRetour href="/reglages" label="Réglages" icone className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Formulaires de demande</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Les questions posées à qui demande une salle, un bureau, le camion, du matériel ou une domiciliation : sur
          le site, dans l’espace client et au devis de l’accueil. Les devis déjà reçus gardent les questions telles
          que les demandeurs les ont lues.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <caption className="sr-only">Formulaires de demande du centre</caption>
          <thead className="bg-muted text-left">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Service</th>
              <th scope="col" className="px-4 py-2 font-medium">Présentation</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Questions posées</th>
              <th scope="col" className="px-4 py-2 font-medium">Réglage</th>
              <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {formulaires.map((form) => {
              const { questionnaire, customized } = settings[form]
              const asked = askedQuestions(questionnaire).length
              const hidden = questionnaire.questions.length - asked
              return (
                <tr key={form} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 text-left font-medium text-primary">{questionnaire.label}</th>
                  <td className="px-4 py-3 text-muted-foreground">{questionnaire.description}</td>
                  <td className="px-4 py-3 text-right tabular">
                    {asked}
                    {hidden > 0 && <span className="block text-xs text-muted-foreground">{hidden} masquée{hidden > 1 ? 's' : ''}</span>}
                  </td>
                  <td className="px-4 py-3">{customized ? 'Réglé par le centre' : 'Questions par défaut'}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/reglages/formulaires/${form}`}
                      aria-label={`Régler le formulaire « ${questionnaire.label} »`}
                      className="inline-flex min-h-6 items-center font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Régler
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
