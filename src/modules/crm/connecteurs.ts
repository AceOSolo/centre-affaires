import type { CrmFlowId } from './flux.ts'

/**
 * L'interface commune des connecteurs de CRM (ADR 065), et leur catalogue.
 *
 * Un connecteur dit ce qui change d'un CRM à l'autre : son nom, les flux qu'il
 * sait servir, l'ancienne variable du serveur qui l'ouvrait, la clé qu'il
 * faut pour l'appeler et la manière d'éprouver cette clé. Le reste — jeton
 * présenté au site, réglage par centre, flux activés, journal — est commun et
 * vit dans ce module (`acces.ts`, `queries.ts`, `appels.ts`).
 *
 * Ce que le CRM échange avec le site reste servi par des routes à son nom
 * (`/api/dolibarr/*`) : leur format est celui que son développeur a branché,
 * il ne change pas avec l'écran.
 *
 * Module pur : rien n'y appelle le réseau ni la base. L'appel du test passe par
 * `http`, fourni par l'appelant (`adresse.ts` en production, un double dans
 * les tests).
 */

/** Identifiants des CRM branchables. L'ordre est celui de la liste à l'écran. */
export const crmConnectorIds = ['dolibarr'] as const
export type CrmConnectorId = (typeof crmConnectorIds)[number]

export function isCrmConnector(value: unknown): value is CrmConnectorId {
  return typeof value === 'string' && (crmConnectorIds as readonly string[]).includes(value)
}

/** Réponse d'un appel sortant, réduite à ce que le test lit. */
export type CrmHttpResponse = { status: number; text(): Promise<string> }

/**
 * Appel sortant vers le CRM : `adresse.ts` le fait sous garde (https, adresse
 * publique, pas de redirection suivie, délai court).
 */
export type CrmHttp = (url: string, headers: Record<string, string>) => Promise<CrmHttpResponse>

/** Issue d'un test d'appel vers le CRM. `message` est lisible par la direction. */
export type CrmTestOutcome = { ok: boolean; statusCode: number | null; message: string }

export type CrmConnector = {
  id: CrmConnectorId
  /** Nom affiché. */
  label: string
  /** Flux que ce connecteur sait servir aujourd'hui. Les autres s'affichent « à venir ». */
  flows: readonly CrmFlowId[]
  /** Routes du site qui servent chaque flux, pour l'écran et la notice. */
  routes: Partial<Record<CrmFlowId, readonly string[]>>
  /** Notice du développeur du CRM, dans le dépôt. */
  notice: string
  /**
   * Variable du serveur qui ouvrait l'API avant l'écran. Encore acceptée pour
   * le centre unique tant qu'aucun jeton n'y est réglé (`acces.ts`).
   */
  legacyTokenEnv?: string
  /** Les identifiants pour appeler le CRM : libellés de l'écran. */
  outbound: {
    keyLabel: string
    keyHelp: string
    urlHelp: string
    urlExample: string
  }
  /** Éprouve l'adresse et la clé par un appel qui ne lit ni n'écrit aucune donnée métier. */
  testConnection(input: { baseUrl: string; key: string }, http: CrmHttp): Promise<CrmTestOutcome>
}

/** Réponse d'un CRM, coupée et mise sur une ligne : elle vient de l'extérieur. */
export function shortExternalText(value: string, max = 160): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
