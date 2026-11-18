import Link from 'next/link'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { ArrowLeftIcon } from '../../../../../components/ui/icons.tsx'
import { withReturn } from '../../../../../lib/redirection.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { mailFolderCounts } from '../../../../../modules/courrier/classement.ts'
import {
  deleteCategoryAction,
  savePersonCategoriesAction,
} from '../../../../../modules/courrier/categories-perso-actions.ts'
import { CreateCategoryForm } from '../../../../../modules/courrier/categories-perso-forms.tsx'
import {
  canCreateCategory,
  MAX_CUSTOM_CATEGORIES,
} from '../../../../../modules/courrier/categories-perso-regles.ts'
import { loadCategoryLists } from '../../../../../modules/courrier/categories-reglages.ts'
import { CategoryListForm } from '../../../../../modules/courrier/categories-reglages-forms.tsx'
import type { MailCategory } from '../../../../../modules/courrier/categories.ts'
import { returnLink } from '../../retour.ts'

export const metadata = { title: 'Mes catégories de courrier' }

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/**
 * Mes catégories de courrier (ADR 060, ADR 078) : une seule liste, celles
 * que le centre propose et celles que la personne a créées, qu'elle renomme,
 * masque et ordonne pour elle seule — le centre garde les siennes intactes, et
 * ses associés ont leur propre liste. Elle crée et supprime les siennes.
 *
 * Mobile d'abord : une carte par catégorie, chaque action à 44 px. La
 * suppression se confirme sur la page même, sans script.
 */
export default async function MesCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { accounts } = await requireClientAccount()
  const params = await searchParams
  const [lists, folders] = await Promise.all([loadCategoryLists(accounts), mailFolderCounts(accounts)])
  const several = accounts.length > 1
  const toDelete = typeof params.supprimer === 'string' ? params.supprimer : undefined
  // D'où l'on vient — la boîte aux lettres filtrée, la fiche d'un pli — : gardé jusqu'au retour.
  const back = returnLink(params.retour, { href: '/compte/courrier', label: 'Ma boîte aux lettres' })
  const retour = back.href === '/compte/courrier' ? null : back.href
  const fait = typeof params.fait === 'string' ? params.fait : undefined
  const declassified = Number(typeof params.plis === 'string' ? params.plis : 0) || 0
  const ownCount = (clientId: string) => (lists.get(clientId) ?? []).filter((entry) => entry.kind === 'perso').length
  // Une limite par entreprise : le formulaire se ferme quand chaque accès l'a atteinte.
  const open = accounts.filter((account) => canCreateCategory(ownCount(account.clientId)))
  const customCount = new Map(folders.custom.map((entry) => [entry.id, entry.total]))
  // Les catégories proposées se comptent pour tout le compte : rangées par la même personne.
  const proposedCount = (key: string) => folders.byCategory[key as MailCategory]?.total ?? 0
  const toConfirm = [...lists.values()].flat().find((entry) => entry.kind === 'perso' && entry.key === toDelete)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={back.href}
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          <ArrowLeftIcon size={20} />
          {back.label}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Mes catégories de courrier
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Renommez, masquez et rangez dans l’ordre qui vous convient les catégories proposées par le
          centre comme celles que vous créez. Ce réglage n’est visible que de vous : vos associés ont le
          leur, et le centre garde ses catégories.
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
      {fait === 'supprimee' && (
        <FlashNotice key="supprimee">
          Catégorie supprimée.{' '}
          {declassified > 0
            ? `${plural(declassified, 'courrier')} redevien${declassified > 1 ? 'nent' : 't'} « non classé${declassified > 1 ? 's' : ''} ».`
            : 'Aucun courrier n’y était rangé.'}
        </FlashNotice>
      )}

      {toConfirm && (
        <div
          id="confirmer-suppression"
          tabIndex={-1}
          className="flex max-w-2xl flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
        >
          <p>
            Supprimer « {toConfirm.name} » ?{' '}
            {(customCount.get(toConfirm.key) ?? 0) > 0
              ? `Les ${plural(customCount.get(toConfirm.key) ?? 0, 'courrier')} qui y sont rangés redeviendront « non classés ».`
              : 'Aucun courrier n’y est rangé.'}{' '}
            Les courriers eux-mêmes ne sont pas touchés.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <form action={deleteCategoryAction}>
              <input type="hidden" name="id" value={toConfirm.key} />
              <button
                type="submit"
                className="press inline-flex min-h-11 w-full items-center justify-center rounded-md border border-destructive/30 bg-white px-5 text-sm font-medium text-destructive hover:bg-destructive/5 sm:w-auto"
              >
                Supprimer la catégorie
              </button>
            </form>
            <Link
              href={withReturn('/compte/courrier/categories', retour)}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-primary hover:bg-muted"
            >
              Annuler
            </Link>
          </div>
        </div>
      )}

      {accounts.map((account) => (
        <section
          key={account.clientId}
          aria-labelledby={`liste-${account.clientId}`}
          className="flex max-w-2xl flex-col gap-3"
        >
          <h2 id={`liste-${account.clientId}`} className="text-lg font-semibold tracking-tight">
            Ma liste{several ? ` — ${account.clientName}` : ''}
          </h2>
          <CategoryListForm
            action={savePersonCategoriesAction}
            hiddenFields={{ entreprise: account.clientId }}
            rows={(lists.get(account.clientId) ?? []).map((entry) => ({
              key: entry.key,
              kind: entry.kind,
              name: entry.name,
              originName: entry.centreName,
              hidden: entry.hidden,
              count: entry.kind === 'perso' ? (customCount.get(entry.key) ?? 0) : several ? undefined : proposedCount(entry.key),
              deleteHref:
                entry.kind === 'perso'
                  ? withReturn(`/compte/courrier/categories?supprimer=${entry.key}#confirmer-suppression`, retour)
                  : undefined,
            }))}
            submitLabel="Enregistrer ma liste"
            audience="client"
            idPrefix={several ? `${account.clientId}-` : ''}
          />
        </section>
      ))}

      <section aria-labelledby="nouvelle" className="max-w-2xl rounded-lg border border-border bg-white p-4 sm:p-5">
        <h2 id="nouvelle" className="text-base font-semibold tracking-tight">
          Nouvelle catégorie
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Vous avez {MAX_CUSTOM_CATEGORIES} catégories à vous, le maximum : supprimez-en une pour en créer une
            autre.
          </p>
        ) : (
          <div className="mt-3">
            <CreateCategoryForm
              accounts={open.map((account) => ({ clientId: account.clientId, clientName: account.clientName }))}
              limitReached={false}
            />
          </div>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          {MAX_CUSTOM_CATEGORIES} catégories à vous au plus{several ? ' par entreprise' : ''}. Une nouvelle
          catégorie se place en fin de liste.
        </p>
      </section>
    </div>
  )
}
