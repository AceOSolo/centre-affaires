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
  constructor(message: string, status: number | null = null) {
    super(message)
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

  async function call(method: 'GET' | 'POST', path: string, json?: unknown): Promise<{ status: number; body: unknown }> {
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
  async function ok(method: 'GET' | 'POST', path: string, what: string, json?: unknown, emptyIs404 = false) {
    const { status, body } = await call(method, path, json)
    if (status >= 200 && status < 300) return body
    if (status === 404 && emptyIs404) return null
    throw new DolibarrApiError(failureMessage(what, status, body), status)
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
  // Dolibarr range la vraie raison (« Field … is mandatory ») dans `error.details`, et ne
  // laisse dans `message` qu'un « Error creating … » sans explication.
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details
  const reasons = (Array.isArray(details) ? details : typeof details === 'string' ? [details] : [])
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim() !== '')
    .join(' ; ')
  const text = [typeof message === 'string' ? message.trim() : '', reasons].filter(Boolean).join(' : ')
  const detail = text ? ` — ${shortExternalText(text, 300)}` : ''
  return `${what} : réponse ${status} de Dolibarr${detail}.`
}
