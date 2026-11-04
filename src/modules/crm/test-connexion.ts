import { formatDateTime } from '../../lib/dates.ts'
import { guardedHttp, CrmCallError } from './adresse.ts'
import { crmConnectors } from './catalogue.ts'
import type { CrmHttp } from './connecteurs.ts'
import type { CrmExchangeEntry, CrmConnectionView, CrmExchangeRow } from './queries.ts'

/**
 * « Tester la connexion » (ADR 065).
 *
 * Le CRM appelle le site, le site ne l'appelle pas encore : le test regarde
 * donc les deux sens séparément.
 *
 * - **Du CRM vers le site** : quel jeton ouvre l'API, et le dernier appel
 *   reçu. Le site ne peut pas déclencher un appel du CRM ; le journal dit s'il
 *   en arrive.
 * - **Du site vers le CRM** : si l'adresse et la clé sont réglées, un appel
 *   qui ne touche aucune donnée (`testConnection` du connecteur), inscrit au
 *   journal.
 */

/** Une ligne du résultat : réussie, en échec, ou simple information (`null`). */
export type CrmTestLine = { ok: boolean | null; text: string }

export type CrmTestInput = {
  view: CrmConnectionView
  /** Adresse et clé en clair, relues pour l'appel. */
  credentials: { baseUrl: string | null; key: string | null; unreadable: boolean } | undefined
  lastInbound: CrmExchangeRow | undefined
  /** La variable du serveur (`DOLIBARR_API_TOKEN`) est-elle posée ? */
  serverTokenSet: boolean
  timeZone: string
  http?: CrmHttp
  /** Inscrit l'appel sortant au journal du centre. */
  record(entry: CrmExchangeEntry): Promise<void>
}

export async function runCrmConnectionTest(input: CrmTestInput): Promise<CrmTestLine[]> {
  const connector = crmConnectors[input.view.connector]
  const lines: CrmTestLine[] = []

  if (input.view.hasToken) {
    lines.push({ ok: true, text: `${connector.label} s’identifie auprès du site avec le jeton réglé ici.` })
  } else if (input.serverTokenSet && connector.legacyTokenEnv) {
    lines.push({
      ok: true,
      text: `${connector.label} s’identifie avec le jeton du serveur (${connector.legacyTokenEnv}). Générer un jeton ici le remplace.`,
    })
  } else {
    lines.push({ ok: false, text: `Aucun jeton : ${connector.label} ne peut pas appeler le site. Générez un jeton et remettez-le à son développeur.` })
  }

  const last = input.lastInbound
  lines.push(
    last
      ? {
          ok: last.ok,
          text: `Dernier appel reçu le ${formatDateTime(last.createdAt, input.timeZone)} : ${last.operation} → ${last.statusCode ?? '—'}${last.message && !last.ok ? ` (${last.message})` : ''}.`,
        }
      : { ok: null, text: `Aucun appel reçu de ${connector.label} au journal.` },
  )

  const credentials = input.credentials
  if (credentials?.unreadable) {
    lines.push({
      ok: false,
      text: 'La clé enregistrée est illisible avec la clé de chiffrement de ce serveur (SECRETS_ENCRYPTION_KEY) : ressaisissez-la.',
    })
    return lines
  }
  if (!credentials?.baseUrl || !credentials.key) {
    lines.push({
      ok: null,
      text: 'Appel du site vers le CRM non éprouvé : adresse ou clé non renseignée. Il ne servira qu’aux envois à venir.',
    })
    return lines
  }

  const start = performance.now()
  let outcome: { ok: boolean; statusCode: number | null; message: string }
  try {
    outcome = await connector.testConnection(
      { baseUrl: credentials.baseUrl, key: credentials.key },
      input.http ?? guardedHttp(),
    )
  } catch (error) {
    outcome = {
      ok: false,
      statusCode: null,
      message: error instanceof CrmCallError ? error.message : 'Appel impossible : erreur du site.',
    }
    if (!(error instanceof CrmCallError)) console.error('Test de connexion au CRM :', error)
  }
  await input.record({
    connector: connector.id,
    direction: 'outbound',
    flow: null,
    operation: 'Test de connexion',
    statusCode: outcome.statusCode,
    ok: outcome.ok,
    message: outcome.message,
    credential: null,
    durationMs: performance.now() - start,
  })
  lines.push({ ok: outcome.ok, text: outcome.message })
  return lines
}
