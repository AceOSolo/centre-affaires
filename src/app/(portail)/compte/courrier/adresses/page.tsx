import Link from 'next/link'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { ArrowLeftIcon, MapPinIcon } from '../../../../../components/ui/icons.tsx'
import { withReturn } from '../../../../../lib/redirection.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { listForwardAddresses } from '../../../../../modules/courrier/carnet-adresses.ts'
import { deleteAddressAction, setDefaultAddressAction } from '../../../../../modules/courrier/carnet-adresses-actions.ts'
import { AddressBookForm } from '../../../../../modules/courrier/carnet-adresses-forms.tsx'
import {
  addressTitle,
  domiciliationLines,
  MAX_FORWARD_ADDRESSES,
} from '../../../../../modules/courrier/carnet-adresses-regles.ts'
import { countryName, forwardAddressLines, forwardCountries } from '../../../../../modules/courrier/demandes-regles.ts'
import { StarIcon } from '../../../../../modules/courrier/icones-client.tsx'
import { loadClientSpace } from '../../espace.ts'
import { returnLink } from '../../retour.ts'

export const metadata = { title: 'Mes adresses' }

/** Confirmations, après un geste sur le carnet (`?fait=`). */
const notices: Record<string, string> = {
  ajoutee: 'Adresse ajoutée à votre carnet. Elle vous sera proposée à chaque demande d’envoi.',
  modifiee: 'Adresse modifiée. Les envois déjà demandés gardent l’adresse choisie à leur demande.',
  'par-defaut': 'Cette adresse vous sera proposée en premier à chaque demande d’envoi.',
  retiree: 'Adresse retirée du carnet. Les envois déjà demandés gardent l’adresse choisie à leur demande.',
}

const secondaryButton =
  'press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-sm font-medium text-primary hover:bg-muted sm:w-auto'
const summaryClass =
  'flex min-h-11 cursor-pointer items-center rounded-md px-1 text-sm font-semibold text-primary'

/**
 * Mes adresses (ADR 078) : l'adresse de domiciliation de chaque entreprise au
 * centre, à recopier sur ses papiers, et le carnet d'adresses de
 * réexpédition — plusieurs adresses, une par défaut, proposées à chaque
 * demande d'envoi d'un pli.
 *
 * Mobile d'abord : une carte par adresse, chaque action à 44 px, en pleine
 * largeur au téléphone. Le retrait se confirme sur la page même, sans script.
 */
export default async function MesAdressesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireClientAccount()
  const { accounts } = access
  const params = await searchParams
  const [space, book] = await Promise.all([loadClientSpace(access), listForwardAddresses(accounts)])
  const { tenant, activeContracts } = space
  const several = accounts.length > 1
  const clientName = new Map(accounts.map((account) => [account.clientId, account.clientName]))
  const fait = typeof params.fait === 'string' ? params.fait : undefined
  const toDelete = typeof params.supprimer === 'string' ? params.supprimer : undefined
  // D'où l'on vient — « Mon compte », la boîte aux lettres filtrée — : gardé jusqu'au retour.
  const back = returnLink(params.retour, { href: '/compte/courrier', label: 'Ma boîte aux lettres' })
  const retour = back.href === '/compte/courrier' ? null : back.href
  const countries = forwardCountries.map((code) => ({ code, name: countryName(code) }))
  // Une limite par entreprise : l'ajout se ferme quand chacune l'a atteinte.
  const open = accounts.filter(
    (account) => book.filter((entry) => entry.clientId === account.clientId).length < MAX_FORWARD_ADDRESSES,
  )
  const domiciled = accounts
    .map((account) => ({
      account,
      contract: activeContracts.find(
        (contract) => contract.clientId === account.clientId && contract.contractType === 'domiciliation',
      ),
    }))
    .filter((entry) => entry.contract)

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
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Mes adresses</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Votre adresse de domiciliation au centre, et les adresses où le centre peut vous réexpédier
          votre courrier.
        </p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      <section aria-labelledby="domiciliation" className="flex max-w-2xl flex-col gap-3">
        <h2 id="domiciliation" className="text-lg font-semibold tracking-tight">
          Adresse de domiciliation
        </h2>
        {domiciled.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            Aucun contrat de domiciliation en cours. Pour domicilier votre entreprise au centre, faites-en
            la demande depuis le site ou auprès de l’accueil.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {domiciled.map(({ account, contract }) => {
              const lines = domiciliationLines(account.clientName, tenant, countryName)
              return (
                <li key={account.clientId} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                  {several && <p className="text-sm font-medium">{account.clientName}</p>}
                  {lines ? (
                    <address className="flex gap-3 not-italic">
                      <MapPinIcon size={20} className="mt-0.5 shrink-0 text-primary" />
                      <span className="text-base">
                        {lines.map((line, index) => (
                          <span key={index} className={`block ${index === 0 ? 'font-semibold' : ''}`}>
                            {line}
                          </span>
                        ))}
                      </span>
                    </address>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Le centre n’a pas encore renseigné son adresse : demandez-la à l’accueil.
                    </p>
                  )}
                  <p className="mt-3 text-sm text-muted-foreground">
                    C’est l’adresse du siège de votre entreprise : recopiez-la sur vos documents officiels,
                    vos factures et votre site.
                    {contract?.currentResource && ` Boîte aux lettres : ${contract.currentResource.name}.`}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="carnet" className="flex max-w-2xl flex-col gap-3">
        <div>
          <h2 id="carnet" className="text-lg font-semibold tracking-tight">
            Adresses de réexpédition{' '}
            <span className="font-normal text-muted-foreground tabular">({book.length})</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Proposées quand vous demandez l’envoi d’un courrier, celle par défaut en premier. Elles sont
            partagées avec les personnes de votre entreprise qui ont accès à cet espace.
          </p>
        </div>
        {book.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            Aucune adresse pour l’instant. Ajoutez-en une ci-dessous : elle vous sera proposée à la
            prochaine demande d’envoi.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {book.map((entry) => (
              <li key={entry.id}>
                <article
                  aria-labelledby={`adresse-${entry.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id={`adresse-${entry.id}`} className="min-w-0 break-words text-base font-semibold">
                      {addressTitle(entry)}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {several && <span className="text-muted-foreground">{clientName.get(entry.clientId)}</span>}
                      {/* Par défaut : dit par le libellé et l'icône, pas par la couleur seule. */}
                      {entry.isDefault && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 font-semibold text-primary">
                          <StarIcon size={16} />
                          Par défaut
                        </span>
                      )}
                    </div>
                  </div>
                  <address className="text-sm not-italic text-foreground">
                    {forwardAddressLines(entry.address).map((line, index) => (
                      <span key={index} className="block">
                        {line}
                      </span>
                    ))}
                  </address>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {!entry.isDefault && (
                      <form action={setDefaultAddressAction}>
                        <input type="hidden" name="id" value={entry.id} />
                        <button type="submit" className={secondaryButton}>
                          <StarIcon size={20} />
                          Utiliser par défaut
                        </button>
                      </form>
                    )}
                    {toDelete !== entry.id && (
                      <Link
                        href={withReturn(`/compte/courrier/adresses?supprimer=${entry.id}#confirmer-suppression`, retour)}
                        className="inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-destructive underline-offset-2 hover:underline"
                      >
                        Retirer « {addressTitle(entry)} »
                      </Link>
                    )}
                  </div>
                  {toDelete === entry.id && (
                    <div
                      id="confirmer-suppression"
                      tabIndex={-1}
                      className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
                    >
                      <p>
                        Retirer « {addressTitle(entry)} » du carnet ? Les envois déjà demandés à cette adresse ne
                        changent pas.
                        {entry.isDefault && ' Une autre adresse du carnet deviendra celle par défaut.'}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <form action={deleteAddressAction}>
                          <input type="hidden" name="id" value={entry.id} />
                          <button
                            type="submit"
                            className="press inline-flex min-h-11 w-full items-center justify-center rounded-md border border-destructive/30 bg-white px-5 text-sm font-medium text-destructive hover:bg-destructive/5 sm:w-auto"
                          >
                            Retirer l’adresse
                          </button>
                        </form>
                        <Link
                          href={withReturn('/compte/courrier/adresses', retour)}
                          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-primary hover:bg-muted"
                        >
                          Annuler
                        </Link>
                      </div>
                    </div>
                  )}
                  <details className="rounded-md border border-border px-3 py-1">
                    <summary className={summaryClass}>Modifier l’adresse</summary>
                    <div className="pb-3 pt-2">
                      <AddressBookForm entry={entry} countries={countries} idPrefix={`modifier-${entry.id}`} />
                    </div>
                  </details>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="nouvelle-adresse" className="max-w-2xl rounded-lg border border-border bg-white p-4 sm:p-5">
        <h2 id="nouvelle-adresse" className="text-base font-semibold tracking-tight">
          Ajouter une adresse
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Votre carnet compte {MAX_FORWARD_ADDRESSES} adresses, le maximum : retirez-en une pour en ajouter une
            autre.
          </p>
        ) : (
          <div className="mt-3">
            <AddressBookForm
              accounts={open.map((account) => ({ clientId: account.clientId, clientName: account.clientName }))}
              countries={countries}
              idPrefix="nouvelle"
            />
          </div>
        )}
      </section>
    </div>
  )
}
