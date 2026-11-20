'use server'

import { revalidatePath } from 'next/cache'

import { parseKey } from '../../lib/chiffrement.ts'
import { isCalendarDate, todayIsoDate } from '../../lib/dates.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { joinExtrafieldSettings, parseQuoteExtrafields } from '../facturation/devis-dolibarr.ts'
import { currentTenantId, currentTimeZone } from '../../lib/tenant.ts'
import { parseCrmBaseUrl } from './adresse.ts'
import { crmConnectors } from './catalogue.ts'
import { isCrmConnector, type CrmConnectorId } from './connecteurs.ts'
import { crmFlows, isCrmFlow, type CrmFlowId } from './flux.ts'
import { crmTokenHash, generateCrmToken } from './jeton.ts'
import {
  crmConnectionView,
  crmOutboundCredentials,
  lastInboundExchange,
  recordCrmExchange,
  removeCrmToken,
  saveCrmFlows,
  saveCrmQuotePush,
  saveCrmSettings,
  setCrmToken,
} from './queries.ts'
import { runCrmConnectionTest, type CrmTestLine } from './test-connexion.ts'

/**
 * Actions de l'écran « Connexion au CRM » (ADR 065), réservées à la direction
 * (`crm.gerer`, ADR 054). Chacune revérifie le droit : une action serveur
 * s'invoque par son identifiant, depuis n'importe quelle page (ADR 008).
 */

const PAGE = '/reglages/crm'

/** Retour d'un formulaire : succès, ou erreurs par champ et message d'ensemble. */
export type CrmFormState = {
  ok?: string
  message?: string
  fieldErrors?: Partial<
    Record<'connector' | 'baseUrl' | 'key' | 'flows' | 'consumptionsFrom' | 'pushQuotes' | 'quoteExtrafields' | 'contactExtrafields' | 'thirdpartyExtrafields', string>
  >
  values?: {
    connector: string
    baseUrl: string
    quoteExtrafields?: string
    contactExtrafields?: string
    thirdpartyExtrafields?: string
  }
} | null

/** Clé du serveur présente et lisible : sans elle, aucun secret n'entre en base. */
function encryptionReady(): boolean {
  try {
    parseKey(process.env.SECRETS_ENCRYPTION_KEY)
    return true
  } catch {
    return false
  }
}

/** Une clé d'API : un seul mot, sans espace ni caractère de contrôle. */
const API_KEY = /^[\x21-\x7e]{8,255}$/

export async function saveCrmSettingsAction(_previous: CrmFormState, formData: FormData): Promise<CrmFormState> {
  const { member } = await requirePermission('crm.gerer')
  const values = {
    connector: String(formData.get('connector') ?? ''),
    baseUrl: String(formData.get('baseUrl') ?? '').trim(),
  }
  const key = String(formData.get('key') ?? '').trim()

  const fieldErrors: NonNullable<CrmFormState>['fieldErrors'] = {}
  if (!isCrmConnector(values.connector)) fieldErrors.connector = 'Choisissez un CRM de la liste.'
  let baseUrl: string | null = null
  if (values.baseUrl) {
    const check = parseCrmBaseUrl(values.baseUrl)
    if (check.ok) baseUrl = check.url
    else fieldErrors.baseUrl = check.message
  }
  if (key && !API_KEY.test(key)) {
    fieldErrors.key = 'De 8 à 255 caractères, sans espace : collez la clé telle que le CRM la donne.'
  } else if (key && !encryptionReady()) {
    fieldErrors.key =
      'Le serveur n’a pas de clé de chiffrement (SECRETS_ENCRYPTION_KEY) : la clé ne peut pas être enregistrée.'
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  await saveCrmSettings(
    { connector: values.connector as CrmConnectorId, baseUrl, key: key || undefined },
    member.id,
  )
  revalidatePath(PAGE)
  return {
    ok: key ? 'Réglages enregistrés, clé comprise. Elle ne sera plus affichée.' : 'Réglages enregistrés.',
    values: { connector: values.connector, baseUrl: baseUrl ?? '' },
  }
}

export async function clearCrmKeyAction(): Promise<CrmFormState> {
  const { member } = await requirePermission('crm.gerer')
  const view = await crmConnectionView()
  await saveCrmSettings({ connector: view.connector, baseUrl: view.baseUrl, key: null }, member.id)
  revalidatePath(PAGE)
  return { ok: 'Clé effacée : le site ne peut plus appeler le CRM.' }
}

/** Le jeton n'existe qu'ici, le temps de cette réponse : la base n'en garde que l'empreinte. */
export type CrmTokenState = { token?: string; ok?: string } | null

/**
 * Générer (ou renouveler) le jeton, `intent=generer`, ou le retirer,
 * `intent=retirer`. Une seule action : l'écran montre l'issue de la dernière.
 */
export async function crmTokenAction(_previous: CrmTokenState, formData: FormData): Promise<CrmTokenState> {
  const { member } = await requirePermission('crm.gerer')
  if (formData.get('intent') === 'retirer') {
    await removeCrmToken(member.id)
    revalidatePath(PAGE)
    const legacy = crmConnectors[(await crmConnectionView()).connector].legacyTokenEnv
    return {
      ok:
        legacy && process.env[legacy]
          ? `Jeton retiré : le CRM s’identifie de nouveau avec le jeton du serveur (${legacy}).`
          : 'Jeton retiré : le CRM ne peut plus appeler le site.',
    }
  }
  const token = generateCrmToken()
  await setCrmToken(crmTokenHash(token), member.id)
  revalidatePath(PAGE)
  return {
    token,
    ok: 'Jeton généré. L’ancien ne fonctionne plus : remettez celui-ci au développeur du CRM.',
  }
}

export async function saveCrmFlowsAction(_previous: CrmFormState, formData: FormData): Promise<CrmFormState> {
  const { member } = await requirePermission('crm.gerer')
  const view = await crmConnectionView()
  const served = crmConnectors[view.connector].flows
  const asked = formData.getAll('flows').map(String)
  if (asked.some((flow) => !isCrmFlow(flow))) return { fieldErrors: { flows: 'Flux inconnu.' } }
  const unavailable = asked.filter((flow) => !served.includes(flow as CrmFlowId))
  if (unavailable.length > 0) {
    return { fieldErrors: { flows: 'Ce flux n’est pas encore servi par le site : il ne peut pas être activé.' } }
  }
  // Un flux à venir n'est jamais coché à l'écran : il garde son état.
  const kept = view.enabledFlows.filter((flow) => !served.includes(flow))
  const flows = crmFlows.filter((flow) => asked.includes(flow) || kept.includes(flow))

  // Les consommations partent à partir d'un jour (ADR 066) : celui saisi,
  // celui déjà réglé, sinon aujourd'hui. Couper le flux garde la date.
  const fromInput = String(formData.get('consumptionsFrom') ?? '').trim()
  if (fromInput && !isCalendarDate(fromInput)) {
    return { fieldErrors: { consumptionsFrom: 'Une date, au format jour/mois/année.' } }
  }
  const consumptionsFrom = flows.includes('consumptions')
    ? fromInput || view.consumptionsFrom || todayIsoDate(await currentTimeZone())
    : fromInput || view.consumptionsFrom

  await saveCrmFlows(flows, member.id, consumptionsFrom)
  revalidatePath(PAGE)
  return { ok: flows.length > 0 ? 'Flux enregistrés.' : 'Flux enregistrés : tous sont coupés, le CRM ne reçoit et n’envoie plus rien.' }
}

/**
 * « Le site crée les devis dans le CRM » et les champs complémentaires de ces
 * devis (ADR 073). L'envoi exige l'adresse et la clé du CRM : sans elles, il
 * n'y a rien à appeler.
 */
export async function saveCrmQuotePushAction(_previous: CrmFormState, formData: FormData): Promise<CrmFormState> {
  const { member } = await requirePermission('crm.gerer')
  const enabled = formData.get('pushQuotes') === 'on'
  const texts = {
    quoteExtrafields: String(formData.get('quoteExtrafields') ?? ''),
    contactExtrafields: String(formData.get('contactExtrafields') ?? ''),
    thirdpartyExtrafields: String(formData.get('thirdpartyExtrafields') ?? ''),
  }
  const values = { connector: '', baseUrl: '', ...texts }
  const proposal = parseQuoteExtrafields(texts.quoteExtrafields)
  const contact = parseQuoteExtrafields(texts.contactExtrafields)
  const thirdparty = parseQuoteExtrafields(texts.thirdpartyExtrafields)
  const fieldErrors: NonNullable<CrmFormState>['fieldErrors'] = {}
  if (!proposal.ok) fieldErrors.quoteExtrafields = proposal.message
  if (!contact.ok) fieldErrors.contactExtrafields = contact.message
  if (!thirdparty.ok) fieldErrors.thirdpartyExtrafields = thirdparty.message
  if (!proposal.ok || !contact.ok || !thirdparty.ok) return { fieldErrors, values }
  const view = await crmConnectionView()
  if (enabled && (!view.baseUrl || !view.hasKey)) {
    return {
      fieldErrors: { pushQuotes: 'Réglez d’abord l’adresse du CRM et sa clé d’API, plus haut sur cette page.' },
      values,
    }
  }
  await saveCrmQuotePush(
    { enabled, quoteExtrafields: joinExtrafieldSettings({ proposal: proposal.value, contact: contact.value, thirdparty: thirdparty.value }) },
    member.id,
  )
  revalidatePath(PAGE)
  return {
    ok: enabled
      ? 'Enregistré : les devis prêts sont créés dans le CRM, dès qu’ils sont prêts puis à chaque passage de la tâche de reprise.'
      : 'Enregistré : le CRM vient chercher les devis (GET /api/dolibarr/devis).',
    values,
  }
}

export type CrmTestState = { lines?: CrmTestLine[]; at?: string } | null

export async function testCrmConnectionAction(): Promise<CrmTestState> {
  await requirePermission('crm.gerer')
  const tenantId = currentTenantId()
  const [view, credentials, lastInbound, timeZone] = await Promise.all([
    crmConnectionView(),
    crmOutboundCredentials(),
    lastInboundExchange(),
    currentTimeZone(),
  ])
  const legacy = crmConnectors[view.connector].legacyTokenEnv
  const lines = await runCrmConnectionTest({
    view,
    credentials,
    lastInbound,
    serverTokenSet: Boolean(legacy && process.env[legacy]),
    timeZone,
    record: (entry) => recordCrmExchange(tenantId, entry),
  })
  revalidatePath(PAGE)
  return { lines, at: new Date().toISOString() }
}
