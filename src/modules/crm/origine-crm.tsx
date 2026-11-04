import { formatDateTime } from '../../lib/dates.ts'
import type { CrmOrigin } from './liens.ts'

/**
 * Une ligne de la fiche (client ou contrat) qui dit qu'elle est tenue par le
 * CRM (ADR 066) : son numéro là-bas, le dernier envoi reçu, et ce qu'une
 * modification faite ici deviendra. À poser dans la liste de définitions de
 * la fiche (`<dl>`).
 */
export function CrmOriginRow({
  origin,
  timeZone,
  object,
  held,
}: {
  origin: CrmOrigin | undefined
  timeZone: string
  /** « Tiers », « Contrat ». */
  object: string
  /** Ce que le CRM tient sur cette fiche, en clair. */
  held: string
}) {
  if (!origin) return null
  return (
    <>
      <dt className="text-muted-foreground">{origin.crmLabel}</dt>
      <dd className="max-w-[70ch]">
        {object} n° <span className="tabular">{origin.externalId}</span>
        {origin.externalRef && origin.externalRef !== origin.externalId ? ` (${origin.externalRef})` : ''}
        {origin.removedAt ? (
          <>
            , supprimé dans {origin.crmLabel} le {formatDateTime(origin.removedAt, timeZone)}. La fiche reste ici ; elle
            n’est plus tenue par {origin.crmLabel}.
          </>
        ) : (
          <>
            , reçu le {formatDateTime(origin.receivedAt, timeZone)}. {held} sont tenus dans {origin.crmLabel} : une
            modification faite ici sera remplacée au prochain envoi.
          </>
        )}
      </dd>
    </>
  )
}
