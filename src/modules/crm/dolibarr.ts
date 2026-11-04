import { shortExternalText, type CrmConnector, type CrmTestOutcome } from './connecteurs.ts'

/**
 * Dolibarr, premier connecteur (ADR 043, 046, 049, 065).
 *
 * Le site expose son API (`/api/dolibarr/*`, `docs/integrations/dolibarr.md`)
 * et le connecteur écrit par le développeur Dolibarr vient la chercher ; les
 * produits arrivent par le module Webhook. Le site n'appelle Dolibarr que pour
 * le test de connexion : les envois sortants sont à venir.
 */

export const dolibarrConnector: CrmConnector = {
  id: 'dolibarr',
  label: 'Dolibarr',
  flows: ['quotes', 'products'],
  routes: {
    quotes: [
      'GET /api/dolibarr/devis',
      'POST /api/dolibarr/devis/{id}/transmis',
      'POST /api/dolibarr/devis/{id}/issue',
    ],
    products: ['POST /api/dolibarr/produits'],
  },
  notice: 'docs/integrations/dolibarr.md',
  legacyTokenEnv: 'DOLIBARR_API_TOKEN',
  outbound: {
    keyLabel: 'Clé d’API Dolibarr',
    keyHelp:
      'La clé d’un utilisateur Dolibarr dédié au site (fiche de l’utilisateur, onglet « Clé pour l’API »). Envoyée dans l’en-tête DOLAPIKEY.',
    urlHelp: 'L’adresse où l’on ouvre Dolibarr, sans « /api/index.php ».',
    urlExample: 'https://crm.exemple.fr',
  },
  testConnection: testDolibarr,
}

/**
 * Appelle `GET /api/index.php/status`, qui rend la version de Dolibarr et
 * exige une clé valide : il éprouve l'adresse, le module API REST et la clé
 * sans lire ni écrire de tiers, de devis ou de facture. Le corps reçu n'est
 * jamais recopié tel quel : seule la version en est tirée.
 */
async function testDolibarr(
  { baseUrl, key }: { baseUrl: string; key: string },
  http: Parameters<CrmConnector['testConnection']>[1],
): Promise<CrmTestOutcome> {
  const response = await http(`${baseUrl}/api/index.php/status`, {
    DOLAPIKEY: key,
    accept: 'application/json',
  })
  const { status } = response
  if (status === 200) {
    const version = dolibarrVersion(await response.text().catch(() => ''))
    return version
      ? { ok: true, statusCode: status, message: `Dolibarr répond et accepte la clé (version ${version}).` }
      : {
          ok: false,
          statusCode: status,
          message:
            'L’adresse répond, mais pas comme l’API de Dolibarr : vérifier l’adresse (sans « /api/index.php »).',
        }
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      statusCode: status,
      message: `Dolibarr refuse la clé (${status}) : vérifier la clé d’API de l’utilisateur dédié au site, et que cet utilisateur est actif.`,
    }
  }
  if (status === 404) {
    return {
      ok: false,
      statusCode: status,
      message:
        'Pas d’API Dolibarr à cette adresse (404) : vérifier l’adresse, et que le module « API REST » est activé dans Dolibarr.',
    }
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      statusCode: status,
      message: `L’adresse redirige ailleurs (${status}) : saisir l’adresse finale de Dolibarr, en https.`,
    }
  }
  return { ok: false, statusCode: status, message: `Réponse inattendue de Dolibarr (${status}).` }
}

/** Version lue dans la réponse de `/status` : `{ "success": { "dolibarr_version": "20.0.2" } }`. */
export function dolibarrVersion(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { success?: { dolibarr_version?: unknown } }
    const version = parsed?.success?.dolibarr_version
    if (typeof version !== 'string' && typeof version !== 'number') return undefined
    const text = shortExternalText(String(version), 32)
    return /^[0-9][0-9A-Za-z.\-+]*$/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}
