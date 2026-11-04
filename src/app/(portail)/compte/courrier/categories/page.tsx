import Link from 'next/link'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { ArrowLeftIcon, ArrowRightIcon } from '../../../../../components/ui/icons.tsx'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { mailCategories } from '../../../../../modules/courrier/categories.ts'
import { deleteCategoryAction } from '../../../../../modules/courrier/categories-perso-actions.ts'
import { listCustomCategories } from '../../../../../modules/courrier/categories-perso.ts'
import { CreateCategoryForm, RenameCategoryForm } from '../../../../../modules/courrier/categories-perso-forms.tsx'
import {
  canCreateCategory,
  MAX_CUSTOM_CATEGORIES,
} from '../../../../../modules/courrier/categories-perso-regles.ts'
import { mailCategoryLabels } from '../../../../../modules/courrier/labels.ts'

export const metadata = { title: 'Mes catégories de courrier' }

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/**
 * Catégories personnelles du courrier (ADR 060) : la personne crée, renomme
 * et supprime les siennes, qui se mêlent à la liste proposée dans le
 * classement et les rubriques de la boîte aux lettres.
 *
 * Mobile d'abord : une carte par catégorie, chaque action en pleine largeur
 * au téléphone, à 44 px. La suppression se confirme sur la page même, sans
 * script : le lien « Supprimer » ouvre la confirmation sous la catégorie.
 */
export default async function MesCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { accounts } = await requireClientAccount()
  const params = await searchParams
  const categories = await listCustomCategories(accounts)
  const several = accounts.length > 1
  const clientName = new Map(accounts.map((account) => [account.clientId, account.clientName]))
  const toDelete = typeof params.supprimer === 'string' ? params.supprimer : undefined
  const fait = typeof params.fait === 'string' ? params.fait : undefined
  const declassified = Number(typeof params.plis === 'string' ? params.plis : 0) || 0
  // Une limite par entreprise : le formulaire se ferme quand chaque accès l'a atteinte.
  const open = accounts.filter(
    (account) => canCreateCategory(categories.filter((category) => category.clientId === account.clientId).length),
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/compte/courrier"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          <ArrowLeftIcon size={20} />
          Ma boîte aux lettres
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Mes catégories de courrier
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Rangez vos courriers dans vos propres catégories, en plus de celles proposées. Elles ne sont
          visibles que de vous : vos associés ont les leurs.
        </p>
      </div>

      <div className="max-w-prose rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <p className="font-medium">Catégorie ou étiquette ?</p>
        <p className="mt-1 text-muted-foreground">
          Une catégorie range un courrier dans <strong className="font-medium text-foreground">une seule</strong>{' '}
          rubrique, comme un dossier : « Impôts et taxes », ou « Comptable » si vous la créez. Les
          étiquettes s’ajoutent librement, <strong className="font-medium text-foreground">plusieurs</strong> par
          courrier : « à payer », « urgent ».
        </p>
      </div>

      {fait === 'creee' && <FlashNotice key="creee">Catégorie créée. Rangez-y vos courriers depuis la boîte aux lettres.</FlashNotice>}
      {fait === 'renommee' && <FlashNotice key="renommee">Catégorie renommée : ses courriers y restent rangés.</FlashNotice>}
      {fait === 'supprimee' && (
        <FlashNotice key="supprimee">
          Catégorie supprimée.{' '}
          {declassified > 0
            ? `${plural(declassified, 'courrier')} redevien${declassified > 1 ? 'nent' : 't'} « non classé${declassified > 1 ? 's' : ''} ».`
            : 'Aucun courrier n’y était rangé.'}
        </FlashNotice>
      )}

      <section aria-labelledby="nouvelle" className="max-w-2xl rounded-lg border border-border bg-white p-4 sm:p-5">
        <h2 id="nouvelle" className="text-base font-semibold tracking-tight">
          Nouvelle catégorie
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Vous avez {MAX_CUSTOM_CATEGORIES} catégories, le maximum : supprimez-en une pour en créer une autre.
          </p>
        ) : (
          <div className="mt-3">
            <CreateCategoryForm
              accounts={open.map((account) => ({ clientId: account.clientId, clientName: account.clientName }))}
              limitReached={false}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="miennes" className="flex max-w-2xl flex-col gap-3">
        <h2 id="miennes" className="text-base font-semibold tracking-tight">
          Mes catégories <span className="font-normal text-muted-foreground tabular">({categories.length})</span>
        </h2>
        {categories.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            Vous n’avez pas encore créé de catégorie. Créez-en une ci-dessus, puis rangez vos courriers
            depuis la boîte aux lettres : cochez-les, puis « Classer ».
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {categories.map((category) => (
              <li key={category.id}>
                <article
                  aria-labelledby={`categorie-${category.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 id={`categorie-${category.id}`} className="min-w-0 break-words text-base font-semibold">
                      {category.name}
                    </h3>
                    {several && (
                      <span className="text-sm text-muted-foreground">{clientName.get(category.clientId)}</span>
                    )}
                  </div>
                  <Link
                    href={`/compte/courrier?categorie=${category.id}`}
                    className="inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {category.mailCount === 0 ? 'Aucun courrier rangé' : `${plural(category.mailCount, 'courrier')} rangé${category.mailCount > 1 ? 's' : ''}`}
                    <ArrowRightIcon size={20} />
                  </Link>
                  <RenameCategoryForm id={category.id} name={category.name} />
                  {toDelete === category.id ? (
                    <div
                      id="confirmer-suppression"
                      tabIndex={-1}
                      className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
                    >
                      <p>
                        Supprimer « {category.name} » ?{' '}
                        {category.mailCount > 0
                          ? `Les ${plural(category.mailCount, 'courrier')} qui y ${category.mailCount > 1 ? 'sont rangés' : 'est rangé'} redeviendr${category.mailCount > 1 ? 'ont' : 'a'} « non classé${category.mailCount > 1 ? 's' : ''} ».`
                          : 'Aucun courrier n’y est rangé.'}{' '}
                        Les courriers eux-mêmes ne sont pas touchés.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <form action={deleteCategoryAction}>
                          <input type="hidden" name="id" value={category.id} />
                          <button
                            type="submit"
                            className="press inline-flex min-h-11 w-full items-center justify-center rounded-md border border-destructive/30 bg-white px-5 text-sm font-medium text-destructive hover:bg-destructive/5 sm:w-auto"
                          >
                            Supprimer la catégorie
                          </button>
                        </form>
                        <Link
                          href="/compte/courrier/categories"
                          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-primary hover:bg-muted"
                        >
                          Annuler
                        </Link>
                      </div>
                    </div>
                  ) : (
                    <Link
                      href={`/compte/courrier/categories?supprimer=${category.id}#confirmer-suppression`}
                      className="inline-flex min-h-11 items-center self-start text-sm font-medium text-destructive underline-offset-2 hover:underline"
                    >
                      Supprimer « {category.name} »
                    </Link>
                  )}
                </article>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          {MAX_CUSTOM_CATEGORIES} catégories au plus{several ? ' par entreprise' : ''}.
        </p>
      </section>

      <section aria-labelledby="proposees" className="max-w-2xl">
        <h2 id="proposees" className="text-base font-semibold tracking-tight">
          Catégories proposées
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Toujours disponibles, elles ne se modifient pas.</p>
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          {mailCategories.map((category) => (
            <li key={category} className="rounded-full border border-border bg-white px-3 py-1">
              {mailCategoryLabels[category]}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
