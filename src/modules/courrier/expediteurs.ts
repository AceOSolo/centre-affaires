/**
 * Expéditeur d'un pli (ADR 058) : une saisie libre, aidée de suggestions,
 * sans lecture automatique (ni IA ni OCR). Sans base ni framework : ces
 * règles servent au serveur comme au navigateur.
 *
 * Les suggestions viennent, dans cet ordre :
 *
 * 1. des expéditeurs déjà saisis pour l'entreprise du pli ;
 * 2. de ceux du centre, toutes entreprises confondues ;
 * 3. d'une liste de départ (`STARTING_SENDERS`), pour un centre qui commence.
 *
 * Elles se calculent sur `mail_items.sender`, sans table à part. La saisie
 * est normalisée (espaces) et ramenée à l'écriture déjà connue quand elle ne
 * s'en distingue que par la casse, les accents ou la ponctuation : « urssaf »
 * devient « URSSAF », et les suggestions ne se dédoublent pas.
 */

/** Au-delà, ce n'est plus un expéditeur mais une note : elle a son champ. */
export const MAX_SENDER_LENGTH = 120

/** Expéditeurs les plus courants du courrier d'une entreprise domiciliée. */
export const STARTING_SENDERS: readonly string[] = [
  'URSSAF',
  'Impôts / DGFiP',
  'CAF',
  'France Travail',
  'Assurance Maladie (CPAM)',
  'Retraite complémentaire Agirc-Arrco',
  'La Poste',
  'Greffe du tribunal de commerce',
  'Tribunal judiciaire',
  'Tribunal de commerce',
  'Commissaire de justice',
  'INPI',
  'INSEE',
  'Préfecture',
  'Mairie',
  'ANTAI (amendes)',
  'BNP Paribas',
  'Société Générale',
  'Crédit Agricole',
  'Crédit Mutuel',
  'LCL',
  'La Banque Postale',
  'Caisse d’Épargne',
  'Banque Populaire',
  'CIC',
  'Qonto',
  'EDF',
  'Engie',
  'Orange',
  'SFR',
  'Bouygues Telecom',
  'Free',
]

/**
 * Lit la saisie d'un expéditeur : espaces de tête et de fin ôtés, espaces
 * intérieurs ramenés à un seul, caractères de contrôle retirés. Vide : pas
 * d'expéditeur.
 */
export function readSender(raw: unknown): { sender: string | null; error?: string } {
  const value = typeof raw === 'string' ? raw : ''
  const sender = value
    .normalize('NFC')
    // Caractères de contrôle (retours à la ligne collés, tabulations…) : des espaces.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (sender === '') return { sender: null }
  if (sender.length > MAX_SENDER_LENGTH) {
    return {
      sender: null,
      error: `L’expéditeur tient en ${MAX_SENDER_LENGTH} caractères au plus. Une précision va dans la note du pli.`,
    }
  }
  return { sender }
}

/**
 * Clé de comparaison : sans accents, sans casse, ponctuation et espaces
 * ramenés à un seul espace. « Impôts / DGFiP » et « impots dgfip » ont la
 * même clé.
 */
export function senderKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** L'écriture déjà connue d'un expéditeur qui ne s'en distingue que par la forme ; sinon la saisie telle quelle. */
export function canonicalSender(sender: string, known: Iterable<string>): string {
  const key = senderKey(sender)
  if (key === '') return sender
  for (const candidate of known) {
    if (senderKey(candidate) === key) return candidate
  }
  return sender
}

/** Expéditeur déjà saisi : combien de plis le portent, et le plus récent. */
export type SenderUse = { clientId: string; sender: string; uses: number; lastAt: Date }

/** Suggestions prêtes à afficher : celles du centre, et celles propres à chaque entreprise. */
export type SenderSuggestions = {
  /** Centre puis liste de départ, sans doublon. */
  centre: string[]
  /** Par entreprise : ses expéditeurs à elle, les plus fréquents d'abord. */
  byClient: Record<string, string[]>
}

/** Expéditeurs propres à une entreprise, proposés en premier. */
export const MAX_OWN_SUGGESTIONS = 10
/** Expéditeurs du centre proposés, avant la liste de départ. */
export const MAX_CENTRE_SUGGESTIONS = 60

type Tally = { key: string; uses: number; lastAt: number }

/** Regroupe des usages par clé : plus fréquents d'abord, puis les plus récents. */
function rank(uses: readonly SenderUse[]): Tally[] {
  const byKey = new Map<string, Tally>()
  for (const use of uses) {
    const key = senderKey(use.sender)
    if (key === '') continue
    const tally = byKey.get(key)
    if (tally) {
      tally.uses += use.uses
      tally.lastAt = Math.max(tally.lastAt, use.lastAt.getTime())
    } else {
      byKey.set(key, { key, uses: use.uses, lastAt: use.lastAt.getTime() })
    }
  }
  return [...byKey.values()].sort((a, b) => b.uses - a.uses || b.lastAt - a.lastAt || (a.key < b.key ? -1 : 1))
}

/**
 * L'écriture retenue pour chaque clé : celle de la liste de départ si elle y
 * figure, sinon la plus employée au centre.
 */
function spellings(uses: readonly SenderUse[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const use of uses) {
    const key = senderKey(use.sender)
    if (key === '') continue
    const forms = counts.get(key) ?? new Map<string, number>()
    forms.set(use.sender, (forms.get(use.sender) ?? 0) + use.uses)
    counts.set(key, forms)
  }
  const chosen = new Map<string, string>()
  for (const [key, forms] of counts) {
    chosen.set(key, [...forms].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0])
  }
  for (const sender of STARTING_SENDERS) chosen.set(senderKey(sender), sender)
  return chosen
}

/**
 * Suggestions d'expéditeurs, calculées sur les plis déjà saisis
 * (`SenderUse`, un par entreprise et par expéditeur). `clientIds` : les
 * entreprises dont l'écran a besoin.
 */
export function senderSuggestions(uses: readonly SenderUse[], clientIds: readonly string[]): SenderSuggestions {
  const spelling = spellings(uses)
  const centreKeys = rank(uses)
    .slice(0, MAX_CENTRE_SUGGESTIONS)
    .map((tally) => tally.key)
  const seen = new Set<string>()
  const centre: string[] = []
  for (const key of [...centreKeys, ...STARTING_SENDERS.map(senderKey)]) {
    if (seen.has(key)) continue
    seen.add(key)
    centre.push(spelling.get(key) as string)
  }
  const usesByClient = new Map<string, SenderUse[]>()
  for (const use of uses) {
    const own = usesByClient.get(use.clientId)
    if (own) own.push(use)
    else usesByClient.set(use.clientId, [use])
  }
  const byClient: Record<string, string[]> = {}
  for (const clientId of new Set(clientIds)) {
    byClient[clientId] = rank(usesByClient.get(clientId) ?? [])
      .slice(0, MAX_OWN_SUGGESTIONS)
      .map((tally) => spelling.get(tally.key) as string)
  }
  return { centre, byClient }
}

/**
 * Toutes les écritures connues, pour ramener une saisie à la sienne
 * (`canonicalSender`) : la liste de départ, puis celles du centre.
 */
export function knownSenders(uses: readonly SenderUse[]): string[] {
  return [...new Set([...STARTING_SENDERS, ...spellings(uses).values()])]
}

/** Les suggestions pour une entreprise : les siennes, puis celles du centre, sans doublon. */
export function suggestionsFor(suggestions: SenderSuggestions, clientId: string | null): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const sender of [...((clientId && suggestions.byClient[clientId]) || []), ...suggestions.centre]) {
    const key = senderKey(sender)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(sender)
  }
  return list
}

/** Identifiant de la liste de suggestions d'une entreprise (`<datalist>`), unique dans la page. */
export const senderListId = (clientId: string | null) => `expediteurs-${clientId ?? 'centre'}`
