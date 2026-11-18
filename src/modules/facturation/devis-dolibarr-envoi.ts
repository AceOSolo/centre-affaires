import { guardedRequest, CrmCallError, type CrmRequest } from '../crm/adresse.ts'
import { dolibarrClient, DolibarrApiError } from '../crm/dolibarr-api.ts'
import { crmOriginOf } from '../crm/liens.ts'
import { crmOutboundCredentials, crmQuotePushSettings, recordCrmExchange } from '../crm/queries.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { sendProposalToDolibarr, type QuoteSite } from './devis-dolibarr.ts'
import { markProposalSent, listProposalsForDolibarr } from './propositions-queries.ts'
import { toDolibarrProposal } from './propositions.ts'

/**
 * Le site crée ses devis dans Dolibarr (ADR 073).
 *
 * `sendProposalToDolibarr` enchaîne les appels d'un devis (tiers, contact,
 * produits, proposition, rattachement du contact) sur un client Dolibarr qu'on
 * lui donne : il ne touche ni la base ni le réseau, les tests lui passent un
 * double. `pushReadyProposals` est la porte de l'application : elle lit le
 * réglage du centre, envoie les devis « prêts », marque « transmis » ceux
 * que Dolibarr a pris et inscrit chaque appel au journal des échanges.
 *
 * Rien n'est perdu quand Dolibarr ne répond pas : le devis reste « prêt », la
 * route `GET /api/dolibarr/devis` le sert encore, et le prochain passage
 * (une demande suivante, ou `/api/maintenance/devis-dolibarr`) le renvoie.
 */

export type PushReport = {
  /** Pourquoi rien n'est parti, le cas échéant. */
  skipped?: 'desactive' | 'flux-coupe' | 'identifiants'
  sent: number
  failed: number
}

/** Devis envoyés à chaque passage, au plus : un passage tient dans la durée d'une tâche planifiée. */
const BATCH_SIZE = 25

let running = false
let again = false

/**
 * Envoie au CRM les devis « prêts » du centre. Un seul passage à la fois dans
 * ce processus : une demande qui arrive pendant un passage en demande un
 * second, qui reprendra ce qu'il aura manqué.
 */
export async function pushReadyProposals(request: CrmRequest = guardedRequest()): Promise<PushReport> {
  if (running) {
    again = true
    return { sent: 0, failed: 0 }
  }
  running = true
  const total: PushReport = { sent: 0, failed: 0 }
  try {
    do {
      again = false
      const report = await pushOnce(request)
      total.sent += report.sent
      total.failed += report.failed
      if (report.skipped) total.skipped = report.skipped
    } while (again)
  } finally {
    running = false
  }
  return total
}

async function pushOnce(request: CrmRequest): Promise<PushReport> {
  const settings = await crmQuotePushSettings()
  if (!settings?.enabled) return { skipped: 'desactive', sent: 0, failed: 0 }
  if (!settings.flowEnabled) return { skipped: 'flux-coupe', sent: 0, failed: 0 }
  const credentials = await crmOutboundCredentials()
  if (!credentials?.baseUrl || !credentials.key) return { skipped: 'identifiants', sent: 0, failed: 0 }

  const tenantId = currentTenantId()
  const tenant = await currentTenant()
  const site: QuoteSite = { timeZone: tenant.timezone, city: tenant.city, postalCode: tenant.postalCode }
  const client = dolibarrClient({ baseUrl: credentials.baseUrl, key: credentials.key, request })

  const proposals = (await listProposalsForDolibarr({ status: 'ready', limit: BATCH_SIZE })).map(toDolibarrProposal)
  const report: PushReport = { sent: 0, failed: 0 }
  for (const proposal of proposals) {
    const start = performance.now()
    const operation = 'POST /proposals'
    try {
      const linked = proposal.tiers.clientId ? await crmOriginOf('client', proposal.tiers.clientId) : undefined
      const sent = await sendProposalToDolibarr(client, proposal, {
        site,
        extrafields: settings.quoteExtrafields,
        linkedThirdpartyId: linked && !linked.removedAt ? linked.externalId : null,
      })
      const marked = await markProposalSent(proposal.id, { id: sent.dolibarrId, ref: sent.dolibarrRef })
      const outcome =
        marked.result === 'ok'
          ? `Devis ${proposal.reference} ${sent.reused ? 'déjà dans' : 'créé dans'} Dolibarr${sent.dolibarrRef ? ` (${sent.dolibarrRef})` : ''}.${sent.warning ? ` ${sent.warning}.` : ''}`
          : `Devis ${proposal.reference} créé dans Dolibarr (${sent.dolibarrId}), mais plus à transmettre : ${marked.message ?? 'état changé entre-temps'}`
      await recordCrmExchange(tenantId, {
        connector: 'dolibarr',
        direction: 'outbound',
        flow: 'quotes',
        operation,
        statusCode: 200,
        ok: marked.result === 'ok',
        message: outcome,
        credential: null,
        durationMs: performance.now() - start,
      })
      if (marked.result === 'ok') report.sent += 1
      else report.failed += 1
    } catch (error) {
      report.failed += 1
      const known = error instanceof DolibarrApiError || error instanceof CrmCallError
      if (!known) console.error('Envoi du devis à Dolibarr :', error)
      await recordCrmExchange(tenantId, {
        connector: 'dolibarr',
        direction: 'outbound',
        flow: 'quotes',
        operation,
        statusCode: error instanceof DolibarrApiError ? error.status : null,
        ok: false,
        message: known ? `Devis ${proposal.reference} : ${error.message}` : `Devis ${proposal.reference} : erreur du site.`,
        credential: null,
        durationMs: performance.now() - start,
      })
      // Dolibarr injoignable : inutile d'essayer les autres, le prochain passage s'en chargera.
      if (error instanceof CrmCallError) break
    }
  }
  return report
}
