import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../../../components/ui/flash-notice.tsx'
import { can } from '../../../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import {
  AbandonAmendmentButton,
  SignAmendmentButton,
} from '../../../../../../modules/contrats/amendment-actions.tsx'
import { AmendmentForm } from '../../../../../../modules/contrats/amendment-form.tsx'
import {
  segmentResourceLabel,
  versionAmountLabel,
  versionLinesForForm,
} from '../../../../../../modules/contrats/avenant-ecran.ts'
import { findAmendment } from '../../../../../../modules/contrats/avenants.ts'
import { listContractDocuments } from '../../../../../../modules/contrats/documents.ts'
import {
  amendmentChangesLabel,
  amendmentStateLabel,
  amendmentStateStyle,
  billingPeriodSuffixes,
} from '../../../../../../modules/contrats/labels.ts'
import { centsToInput, lineToFormValues, targetOf } from '../../../../../../modules/contrats/lignes.ts'
import { ContractLinesTable } from '../../../../../../modules/contrats/lines-table.tsx'
import { formatCalendarDate } from '../../../../../../modules/contrats/occupation.ts'
import { loadLinesCatalog } from '../../../../../../modules/contrats/offres-queries.ts'
import { findContract } from '../../../../../../modules/contrats/queries.ts'
import { findContractTerms, segmentOn } from '../../../../../../modules/contrats/versions.ts'
import { formatCents } from '../../../../../../modules/facturation/tarifs.ts'
import { listResources } from '../../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Avenant' }

const notices: Record<string, string> = {
  cree: 'Brouillon d’avenant enregistré. Relisez-le, puis signez-le pour qu’il prenne effet.',
  modifie: 'Brouillon d’avenant enregistré.',
  signe: 'Avenant signé : il prend effet à sa date, et son document est archivé.',
  abandonne: 'Brouillon d’avenant abandonné. Il reste consultable ici.',
}

/**
 * Un avenant (R12, ADR 025) : ce qu'il change, et, tant qu'il est brouillon,
 * sa modification, sa signature ou son abandon. Signé, il est figé ; son
 * document s'ouvre tel qu'il a été archivé.
 */
export default async function AmendmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; avenantId: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  const { member } = await requirePermission('contrats.consulter')
  const { id, avenantId } = await params
  const { fait } = await searchParams
  if (!isUuid(id) || !isUuid(avenantId)) notFound()
  const [contract, amendment, timeZone] = await Promise.all([
    findContract(id),
    findAmendment(id, avenantId),
    currentTimeZone(),
  ])
  if (!contract || !amendment) notFound()

  const money = (cents: number) => formatCents(cents, contract.currency)
  const editable =
    amendment.status === 'draft' &&
    amendment.deletedAt === null &&
    contract.status === 'active' &&
    contract.deletedAt === null &&
    can(member.role, 'contrats.avenants')
  const documents = amendment.status === 'signed' ? await listContractDocuments(id) : []
  const document = documents.find((candidate) => candidate.amendmentId === amendment.id)
  const summary = amendmentChangesLabel(
    { ...amendment, lineCount: amendment.lines.length },
    money,
    contract.billingPeriod,
  )

  let form: React.ReactNode = null
  if (editable) {
    const [terms, resources] = await Promise.all([findContractTerms(id), listResources()])
    const base = segmentOn(
      terms.versions.filter((version) => version.amendmentId !== amendment.id),
      amendment.effectiveOn,
    )
    const catalog = await loadLinesCatalog([...amendment.lines, ...(base?.lines ?? [])])
    form = (
      <section aria-labelledby="modifier-title" className="flex flex-col gap-4">
        <h2 id="modifier-title" className="text-sm font-semibold tracking-tight">
          Modifier le brouillon
        </h2>
        <AmendmentForm
          contractId={id}
          amendmentId={amendment.id}
          defaults={{
            effectiveOn: amendment.effectiveOn,
            reason: amendment.reason ?? '',
            priceMode:
              amendment.lines.length > 0 ? 'lines' : amendment.amountCents !== null ? 'amount' : 'unchanged',
            amount:
              amendment.lines.length === 0 && amendment.amountCents !== null
                ? centsToInput(amendment.amountCents)
                : '',
            changesResource: amendment.changesResource,
            resourceId: amendment.resourceId ?? '',
          }}
          initialLines={
            amendment.lines.length > 0
              ? amendment.lines.map((line, index) =>
                  lineToFormValues(String(index), { ...line, target: targetOf(line) }),
                )
              : versionLinesForForm(base, contract)
          }
          catalog={catalog}
          resources={resources}
          currentResourceLabel={segmentResourceLabel(terms.segments, amendment.effectiveOn)}
          currentAmountLabel={versionAmountLabel(
            terms.versions.filter((version) => version.amendmentId !== amendment.id),
            amendment.effectiveOn,
            contract,
          )}
          periodSuffix={billingPeriodSuffixes[contract.billingPeriod]}
          currency={contract.currency}
        />
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/contrats/${id}#avenants`} className="text-sm text-muted-foreground hover:underline">
          ← Contrat {contract.reference}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Avenant n° {amendment.number}
          </h1>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${amendmentStateStyle(amendment)}`}>
            {amendmentStateLabel(amendment)}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Contrat {contract.reference} — {contract.client.name}
        </p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Date d’effet</dt>
        <dd className="tabular">{formatCalendarDate(amendment.effectiveOn)}</dd>
        <dt className="text-muted-foreground">Objet</dt>
        <dd>{amendment.reason ?? '—'}</dd>
        <dt className="text-muted-foreground">Ce qu’il change</dt>
        <dd>{summary}</dd>
        {amendment.signedAt && (
          <>
            <dt className="text-muted-foreground">Signé le</dt>
            <dd className="tabular">{formatDateTime(amendment.signedAt, timeZone)}</dd>
          </>
        )}
        {document && (
          <>
            <dt className="text-muted-foreground">Document</dt>
            <dd>
              <Link
                href={`/contrats/${id}/document?version=${document.version}`}
                className="text-primary underline underline-offset-2"
              >
                Version {document.version}, archivée
              </Link>
            </dd>
          </>
        )}
      </dl>

      {amendment.lines.length > 0 && (
        <section aria-labelledby="lignes-title" className="flex flex-col gap-3">
          <h2 id="lignes-title" className="text-sm font-semibold tracking-tight">
            Lignes de l’avenant
          </h2>
          <p className="text-xs text-muted-foreground">
            Elles remplacent toutes les lignes précédentes à la date d’effet.
          </p>
          <ContractLinesTable
            lines={amendment.lines}
            currency={contract.currency}
            periodSuffix={billingPeriodSuffixes[contract.billingPeriod]}
            caption={`Lignes de l’avenant n° ${amendment.number}`}
          />
        </section>
      )}

      {editable && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
          <p className="text-sm font-medium">Signer ou abandonner</p>
          <p className="text-xs text-muted-foreground">
            La signature vérifie la date d’effet et, pour un changement de ressource, que la nouvelle
            ressource est libre à partir de cette date.{' '}
            <Link
              href={`/contrats/${id}/document?avenant=${amendment.id}`}
              className="text-primary underline underline-offset-2"
            >
              Aperçu du document
            </Link>
          </p>
          <div className="flex flex-wrap gap-3">
            <SignAmendmentButton
              contractId={id}
              amendmentId={amendment.id}
              number={amendment.number}
              summary={`À partir du ${formatCalendarDate(amendment.effectiveOn)}. ${summary}`}
            />
            <AbandonAmendmentButton contractId={id} amendmentId={amendment.id} number={amendment.number} />
          </div>
        </div>
      )}

      {form}
    </div>
  )
}
