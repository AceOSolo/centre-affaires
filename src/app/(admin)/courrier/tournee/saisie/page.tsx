import Link from 'next/link'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { todayIsoDate, toWallClock } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { findSenderSuggestions } from '../../../../../modules/courrier/expediteurs-queries.ts'
import { MailEntryForm } from '../../../../../modules/courrier/saisie-groupee-form.tsx'
import { listMailRecipients } from '../../../../../modules/courrier/saisie-groupee.ts'

export const metadata = { title: 'Saisie groupée du courrier' }

const positive = (value: string | undefined) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Saisie groupée (tournée du courrier, ADR 044, ADR 058) : une photo = un
 * pli. L'accueil choisit l'entreprise et le type, prend les photos des
 * enveloppes, relit le récapitulatif et enregistre tout en un envoi. Les plis
 * entrent dans la tournée ouverte ; les domiciliés sont prévenus à sa fin,
 * comme pour le reste.
 */
export default async function SaisieGroupeePage({
  searchParams,
}: {
  searchParams: Promise<{ plis?: string; entreprises?: string; photos?: string; saisie?: string }>
}) {
  await requirePermission('courrier.gerer')
  const params = await searchParams
  const items = positive(params.plis)
  const companies = positive(params.entreprises)
  const photos = positive(params.photos)
  const timeZone = await currentTimeZone()
  const recipients = await listMailRecipients(todayIsoDate(timeZone))
  const suggestions = await findSenderSuggestions(recipients.map((recipient) => recipient.id))

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/courrier/tournee" className="text-sm text-muted-foreground hover:underline">
          ← Tournée du courrier
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Saisie groupée</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Une photo d’enveloppe, un pli : choisissez l’entreprise et le type, prenez ou déposez les
          photos, puis passez à l’entreprise suivante. Relisez le récapitulatif, précisez les
          expéditeurs si vous le souhaitez, et enregistrez. Les plis entrent fermés dans la tournée en
          cours ; personne n’est prévenu avant sa fin.
        </p>
      </div>

      {items > 0 && (
        // Clé propre à l'avis : le formulaire, à côté, porte déjà `params.saisie`.
        <FlashNotice key={`avis-${params.saisie ?? 'saisie'}`}>
          {items} pli{items > 1 ? 's' : ''} enregistré{items > 1 ? 's' : ''} pour {companies}{' '}
          entreprise{companies > 1 ? 's' : ''}
          {photos > 0 &&
            (photos < items
              ? `, dont ${photos} avec la photo de l’enveloppe`
              : items === 1
                ? ', avec la photo de l’enveloppe'
                : ', tous avec la photo de l’enveloppe')}
          .{' '}
          <Link href="/courrier/tournee" className="font-medium underline underline-offset-2">
            {photos < items
              ? 'Voir la tournée, ajouter les photos manquantes et la terminer'
              : 'Voir la tournée et la terminer'}
          </Link>
        </FlashNotice>
      )}

      <noscript>
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          La saisie groupée a besoin de JavaScript pour préparer les photos.{' '}
          <Link href="/courrier/nouveau" className="font-medium underline underline-offset-2">
            Enregistrez les plis un par un
          </Link>
          .
        </p>
      </noscript>

      {recipients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucun client. Le courrier s’enregistre au nom d’une entreprise : créez d’abord sa fiche.
          </p>
          <Link
            href="/clients/nouveau"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Créer un client
          </Link>
        </div>
      ) : (
        <MailEntryForm
          // Remonté après chaque enregistrement : saisie vide, heure du moment.
          key={params.saisie ?? 'nouvelle'}
          recipients={recipients}
          suggestions={suggestions}
          defaultReceivedAt={toWallClock(new Date(), timeZone)}
        />
      )}
    </div>
  )
}
