import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { listDocumentKinds } from '../../../../modules/clients/pieces-queries.ts'
import {
  DocumentKindForm,
  DocumentKindMove,
  DocumentKindToggle,
} from '../../../../modules/clients/pieces-reglages.tsx'
import { situationLabels } from '../../../../modules/clients/pieces-regles.ts'

export const metadata = { title: 'Pièces justificatives demandées' }

/**
 * Pièces justificatives demandées pour une domiciliation (ADR 075), réglées
 * par centre : leur nom, l'aide montrée au client, les sociétés à qui elles
 * sont demandées (en création, immatriculées, toutes), leur ordre. Tant que
 * le centre n'y touche pas, la liste par défaut du code s'applique ; la
 * première modification l'écrit.
 *
 * Une pièce se retire de la liste, elle ne se supprime pas : celles déjà
 * déposées restent, avec leur nom du jour du dépôt.
 */
export default async function DocumentKindsPage() {
  await requirePermission('centre.configurer')
  const { kinds, customized } = await listDocumentKinds()

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/reglages" className="text-sm text-muted-foreground hover:underline">
          ← Réglages
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Pièces justificatives demandées</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Domiciliation : ce que le client dépose dans son espace après sa demande, selon que sa société est en cours de
          création ou déjà immatriculée. L’accusé de réception de la demande les cite, et l’accueil les vérifie sur la
          fiche du client.
        </p>
        {!customized && (
          <p className="mt-2 max-w-prose text-sm text-foreground">
            C’est la liste par défaut : elle s’applique tant que vous n’y touchez pas.
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Pièces demandées, dans l’ordre où le client les voit</caption>
          <thead className="border-b border-border bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2">Ordre</th>
              <th scope="col" className="px-4 py-2">Pièce</th>
              <th scope="col" className="px-4 py-2">Demandée à</th>
              <th scope="col" className="px-4 py-2">État</th>
              <th scope="col" className="px-4 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind, index) => (
              <tr key={kind.code} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    <DocumentKindMove code={kind.code} label={kind.label} direction="up" disabled={index === 0} />
                    <DocumentKindMove
                      code={kind.code}
                      label={kind.label}
                      direction="down"
                      disabled={index === kinds.length - 1}
                    />
                  </div>
                </td>
                <td className="px-4 py-2">
                  <span className="font-medium">{kind.label}</span>
                  {kind.help && <span className="block text-xs text-muted-foreground">{kind.help}</span>}
                </td>
                <td className="px-4 py-2">{situationLabels[kind.appliesTo]}</td>
                <td className="px-4 py-2">
                  {/* L'état se lit au libellé. */}
                  <span
                    className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                      kind.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {kind.active ? 'Demandée' : 'Retirée'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <details>
                      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-md border border-border bg-white px-3 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                        Modifier<span className="sr-only"> : {kind.label}</span>
                      </summary>
                      <div className="mt-2 w-80 max-w-full">
                        <DocumentKindForm kind={kind} />
                      </div>
                    </details>
                    <DocumentKindToggle code={kind.code} label={kind.label} active={kind.active} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {kinds.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucune pièce : ajoutez la première ci-dessous.</p>
      )}

      <section aria-labelledby="ajouter-titre" className="max-w-xl rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="ajouter-titre" className="text-sm font-semibold tracking-tight">
          Ajouter une pièce
        </h2>
        <div className="mt-3">
          <DocumentKindForm />
        </div>
      </section>
    </div>
  )
}
