import type { CrmRequest } from './adresse.ts'
import { shortExternalText } from './connecteurs.ts'

/**
 * Le client de l'API REST de Dolibarr que le site appelle pour y créer ses
 * devis (ADR 073). Module sans réseau ni base : l'appel passe par `request`,
 * qui est `guardedRequest` (`adresse.ts`) en production et un double dans les
 * tests.
 *
 * Il ne fait que les appels dont l'envoi d'un devis a besoin : retrouver ou
 * créer un tiers et son contact, retrouver un produit par sa référence,
 * créer la proposition commerciale et lui rattacher son contact.
 */

/** Échec d'un appel à Dolibarr, avec la phrase que le journal et l'écran affichent. */
export class DolibarrApiError extends Error {
  readonly status: number | null
  /** Le corps JSON que le site avait envoyé, pour le débogage à la main. */
  readonly sent: unknown
  /** L'appel refusé, sans l'adresse du CRM : « POST /contacts ». */
  readonly endpoint: string | null
  constructor(message: string, status: number | null = null, sent?: unknown, endpoint: string | null = null) {
    super(message)
    this.sent = sent
    this.endpoint = endpoint
    this.status = status
  }
}

export type DolibarrClient = {
  /** Identifiant du tiers qui porte ce SIRET, ce SIREN ou cette adresse (dans cet ordre), sinon `undefined`. */
  findThirdparty(by: { siret?: string | null; siren?: string | null; email?: string | null }): Promise<string | undefined>
  createThirdparty(body: Record<string, unknown>): Promise<string>
  /** Contact du tiers qui porte cette adresse. */
  findContact(thirdpartyId: string, email: string): Promise<string | undefined>
  createContact(body: Record<string, unknown>): Promise<string>
  /** Contact sans tiers qui porte cette adresse (le plus ancien), `undefined` s'il n'y en a pas. */
  findOrphanContact(email: string): Promise<string | undefined>
  /** Rattache un contact sans tiers à ce tiers (`PUT /contacts/{id}`). */
  attachContact(contactId: string, thirdpartyId: string): Promise<void>
  /** Identifiant du produit ou service de cette référence, `undefined` s'il n'existe pas. */
  findProductId(ref: string): Promise<string | undefined>
  /** Proposition déjà créée pour cette référence client : rend un envoi interrompu rejouable. */
  findProposalByClientRef(clientRef: string): Promise<{ id: string; ref: string | null } | undefined>
  createProposal(body: Record<string, unknown>): Promise<string>
  /** Rattache le contact à la proposition, comme interlocuteur « CUSTOMER ». */
  linkProposalContact(proposalId: string, contactId: string): Promise<void>
  /** Référence que Dolibarr a donnée à la proposition (`(PROV12)` tant qu'elle est brouillon). */
  proposalRef(proposalId: string): Promise<string | null>
}

const API = '/api/index.php'

/**
 * Valeur admise dans un filtre `sqlfilters` : Dolibarr refuse les filtres
 * qui ressemblent à une injection, et la valeur vient d'un demandeur. Une
 * valeur qui sort de ce jeu de caractères n'est pas cherchée.
 */
const FILTER_VALUE = /^[\p{L}\p{N}.@+_\- ]{1,120}$/u

export function dolibarrClient(options: { baseUrl: string; key: string; request: CrmRequest }): DolibarrClient {
  const { baseUrl, key, request } = options
  const headers = { DOLAPIKEY: key, accept: 'application/json' }

  async function call(method: 'GET' | 'POST' | 'PUT', path: string, json?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await request({ url: `${baseUrl}${API}${path}`, method, headers, json })
    const raw = await response.text().catch(() => '')
    let body: unknown = raw
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      // Corps non JSON (page d'erreur d'un frontal) : gardé tel quel.
    }
    return { status: response.status, body }
  }

  /** Réponse réussie, ou l'erreur que Dolibarr donne, lisible. `404` : rien trouvé, quand `emptyIs404`. */
  async function ok(method: 'GET' | 'POST' | 'PUT', path: string, what: string, json?: unknown, emptyIs404 = false) {
    const { status, body } = await call(method, path, json)
    if (status >= 200 && status < 300) return body
    if (status === 404 && emptyIs404) return null
    throw new DolibarrApiError(failureMessage(what, status, body), status, json, `${method} ${path}`)
  }

  const filtered = (conditions: string[]) => encodeURIComponent(conditions.map((condition) => `(${condition})`).join(' and '))

  async function firstId(path: string, what: string): Promise<string | undefined> {
    const body = await ok('GET', path, what, undefined, true)
    return Array.isArray(body) && body[0] ? idOf(body[0]) : undefined
  }

  return {
    async findThirdparty({ siret, siren, email }) {
      const searches: [string, string | null | undefined][] = [
        ['t.siret', siret],
        ['t.siren', siren],
        ['t.email', email?.toLowerCase()],
      ]
      for (const [column, value] of searches) {
        if (!value || !FILTER_VALUE.test(value)) continue
        const id = await firstId(
          `/thirdparties?sortfield=t.rowid&sortorder=ASC&limit=1&sqlfilters=${filtered([`${column}:=:'${value}'`])}`,
          'Recherche du tiers',
        )
        if (id) return id
      }
      return undefined
    },
    async createThirdparty(body) {
      return idFromCreation(await ok('POST', '/thirdparties', 'Création du tiers', body), 'du tiers')
    },
    async findContact(thirdpartyId, email) {
      if (!FILTER_VALUE.test(email)) return undefined
      return firstId(
        `/contacts?thirdparty_ids=${encodeURIComponent(thirdpartyId)}&limit=1&sqlfilters=${filtered([`t.email:=:'${email.toLowerCase()}'`])}`,
        'Recherche du contact',
      )
    },
    async createContact(body) {
      return idFromCreation(await ok('POST', '/contacts', 'Création du contact', body), 'du contact')
    },
    async findOrphanContact(email) {
      if (!FILTER_VALUE.test(email)) return undefined
      // Le filtre « sans tiers » est fait ici : tous les contacts de cette adresse, puis le premier sans `socid`.
      const body = await ok(
        'GET',
        `/contacts?sortfield=t.rowid&sortorder=ASC&limit=50&sqlfilters=${filtered([`t.email:=:'${email.toLowerCase()}'`])}`,
        'Recherche du contact sans tiers',
        undefined,
        true,
      )
      if (!Array.isArray(body)) return undefined
      const orphan = body.find((contact) => {
        const thirdparty = (contact as { socid?: unknown; fk_soc?: unknown } | null)?.socid ?? (contact as { fk_soc?: unknown } | null)?.fk_soc
        return thirdparty === null || thirdparty === undefined || thirdparty === '' || thirdparty === 0 || thirdparty === '0'
      })
      return orphan ? idOf(orphan) : undefined
    },
    async attachContact(contactId, thirdpartyId) {
      await ok('PUT', `/contacts/${encodeURIComponent(contactId)}`, 'Rattachement du contact au tiers', {
        socid: thirdpartyId,
        // Les déclencheurs de Dolibarr lisent `fk_soc` : voir `buildContactBody`.
        fk_soc: thirdpartyId,
      })
    },
    async findProductId(ref) {
      const body = await ok('GET', `/products/ref/${encodeURIComponent(ref)}`, `Recherche du produit « ${ref} »`, undefined, true)
      return body && typeof body === 'object' ? idOf(body) : undefined
    },
    async findProposalByClientRef(clientRef) {
      if (!FILTER_VALUE.test(clientRef)) return undefined
      const body = await ok(
        'GET',
        `/proposals?limit=1&sqlfilters=${filtered([`t.ref_client:=:'${clientRef}'`])}`,
        'Recherche de la proposition',
        undefined,
        true,
      )
      const found = Array.isArray(body) ? body[0] : undefined
      const id = found ? idOf(found) : undefined
      if (!id) return undefined
      const ref = (found as { ref?: unknown }).ref
      return { id, ref: typeof ref === 'string' && ref ? shortExternalText(ref, 64) : null }
    },
    async createProposal(body) {
      return idFromCreation(await ok('POST', '/proposals', 'Création de la proposition', body), 'de la proposition')
    },
    async linkProposalContact(proposalId, contactId) {
      await ok(
        'POST',
        `/proposals/${encodeURIComponent(proposalId)}/contact/${encodeURIComponent(contactId)}/CUSTOMER`,
        'Rattachement du contact',
      )
    },
    async proposalRef(proposalId) {
      const body = await ok('GET', `/proposals/${encodeURIComponent(proposalId)}?contact_list=0`, 'Lecture de la proposition')
      const ref = body && typeof body === 'object' ? (body as { ref?: unknown }).ref : undefined
      return typeof ref === 'string' && ref ? shortExternalText(ref, 64) : null
    },
  }
}

/** Identifiant d'un objet lu : `id`, ou `rowid` pour les anciennes versions. */
function idOf(object: unknown): string | undefined {
  if (!object || typeof object !== 'object') return undefined
  const { id, rowid } = object as { id?: unknown; rowid?: unknown }
  const value = id ?? rowid
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).trim() : undefined
}

/** Un `POST` de Dolibarr rend l'identifiant créé, nu (`123`) ou entre guillemets. */
function idFromCreation(body: unknown, what: string): string {
  const id = typeof body === 'number' || typeof body === 'string' ? String(body).trim() : ''
  if (!/^[1-9]\d{0,17}$/.test(id)) {
    throw new DolibarrApiError(`Dolibarr n’a pas rendu l’identifiant ${what} créé.`)
  }
  return id
}

/** Phrase pour le journal : l'étape, le code, et le message de Dolibarr s'il en donne un. */
function failureMessage(what: string, status: number, body: unknown): string {
  if (status === 401 || status === 403) {
    return `${what} : Dolibarr refuse la clé (${status}). L’utilisateur de l’API doit être actif et avoir le droit d’écrire devis et tiers.`
  }
  const message =
    body && typeof body === 'object'
      ? ((body as { error?: { message?: unknown } }).error?.message ?? (body as { message?: unknown }).message)
      : typeof body === 'string'
        ? body
        : undefined
  // Dolibarr ne laisse dans `message` qu'un « Error creating … » : la vraie raison
  // (« Field … is mandatory ») est dans `error.details`, ou ailleurs selon la version.
  const reasons = extraReasons(body).join(' ; ')
  const text = [typeof message === 'string' ? message.trim() : '', reasons].filter(Boolean).join(' : ')
  const hint =
    status >= 500 && !reasons ? ' Dolibarr ne dit pas pourquoi : voir son documents/dolibarr.log.' : ''
  const detail = text ? ` — ${shortExternalText(text, 300)}` : ''
  return `${what} : réponse ${status} de Dolibarr${detail}.${hint}`
}

/** Les textes que Dolibarr joint à une erreur en plus de son message : `error.details` et `debug.details`. */
function extraReasons(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const { error, debug } = body as { error?: Record<string, unknown>; debug?: { details?: unknown } }
  const texts: string[] = []
  const collect = (value: unknown, depth = 0): void => {
    if (typeof value === 'string') {
      if (value.trim()) texts.push(value.trim())
    } else if (depth < 3 && value && typeof value === 'object') {
      for (const item of Object.values(value)) collect(item, depth + 1)
    }
  }
  // Dolibarr 16 met la raison dans `error["0"]`, `error["1"]`… (liste à plat), d'autres versions dans `error.details`.
  for (const [key, value] of Object.entries(error ?? {})) {
    if (key !== 'code' && key !== 'message') collect(value)
  }
  collect(debug?.details)
  return [...new Set(texts)]
}
