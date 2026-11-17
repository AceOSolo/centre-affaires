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
 * Depuis l'ADR 079, le centre règle **sa liste** dans Réglages
 * (`tenants.mail_suggested_senders`) : ajouter, renommer, retirer, ordonner.
 * Réglée, elle remplace les points 2 et 3 — l'accueil ne se voit plus proposer
 * un expéditeur que le centre a retiré — ; l'écran du réglage propose
 * d'ajouter les expéditeurs souvent saisis qui n'y sont pas. Tant qu'elle ne
 * l'est pas (`null`), rien ne change.
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

/** Liste réglée par le centre (ADR 079) ; `null` : pas réglée, celle du code. */
export type SenderList = readonly string[] | null

/**
 * L'écriture retenue pour chaque clé : celle de la liste du centre (ou de
 * départ) si elle y figure, sinon la plus employée au centre.
 */
function spellings(uses: readonly SenderUse[], list: SenderList = null): Map<string, string> {
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
  for (const sender of list ?? STARTING_SENDERS) chosen.set(senderKey(sender), sender)
  return chosen
}

/**
 * Suggestions d'expéditeurs, calculées sur les plis déjà saisis
 * (`SenderUse`, un par entreprise et par expéditeur). `clientIds` : les
 * entreprises dont l'écran a besoin. `list` : la liste réglée par le centre ;
 * elle tient alors lieu de suggestions du centre, dans son ordre.
 */
export function senderSuggestions(
  uses: readonly SenderUse[],
  clientIds: readonly string[],
  list: SenderList = null,
): SenderSuggestions {
  const spelling = spellings(uses, list)
  const centreKeys =
    list === null
      ? [
          ...rank(uses)
            .slice(0, MAX_CENTRE_SUGGESTIONS)
            .map((tally) => tally.key),
          ...STARTING_SENDERS.map(senderKey),
        ]
      : list.map(senderKey)
  const seen = new Set<string>()
  const centre: string[] = []
  for (const key of centreKeys) {
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
 * (`canonicalSender`) : la liste du centre (ou de départ), puis celles du centre.
 */
export function knownSenders(uses: readonly SenderUse[], list: SenderList = null): string[] {
  return [...new Set([...(list ?? STARTING_SENDERS), ...spellings(uses, list).values()])]
}

/* -------------------------------------------------------------------------- */
/* La liste réglée par le centre (ADR 079)                                    */
/* -------------------------------------------------------------------------- */

/** Au plus dans la liste du centre : au-delà, la liste ne se parcourt plus. */
export const MAX_SUGGESTED_SENDERS = 200

/** Expéditeurs souvent saisis proposés à l'ajout, sur l'écran du réglage. */
export const MAX_FREQUENT_MISSING = 15

/**
 * La liste telle qu'elle est proposée aujourd'hui, point de départ de
 * l'écran du réglage : la liste réglée, sinon les expéditeurs les plus saisis
 * au centre puis la liste de départ — exactement ce que l'accueil voit.
 * L'enregistrer sans y toucher ne change donc rien.
 */
export function currentSenderList(uses: readonly SenderUse[], list: SenderList): string[] {
  return senderSuggestions(uses, [], list).centre
}

/** Expéditeurs souvent saisis au centre, absents de la liste : proposés à l'ajout. */
export function frequentMissing(uses: readonly SenderUse[], list: readonly string[]): string[] {
  const listed = new Set(list.map(senderKey))
  const spelling = spellings(uses, list)
  return rank(uses)
    .filter((tally) => !listed.has(tally.key))
    .slice(0, MAX_FREQUENT_MISSING)
    .map((tally) => spelling.get(tally.key) as string)
}

export type SenderListReading = {
  /** La liste à enregistrer, dans l'ordre, lignes vides ôtées. */
  list: string[]
  /** Par rang de la ligne saisie (0, 1, …) : ce qui ne va pas. */
  lineErrors: Record<number, string>
  /** Erreur de la liste entière. */
  error?: string
}

/**
 * Lit la liste saisie à l'écran : chaque ligne normalisée comme une saisie
 * (`readSender`), les lignes vides ôtées (vider une ligne la retire), un
 * doublon — à la casse, aux accents et à la ponctuation près — refusé sur sa
 * seconde ligne, 200 expéditeurs au plus.
 */
export function readSenderList(lines: readonly unknown[]): SenderListReading {
  const list: string[] = []
  const lineErrors: Record<number, string> = {}
  const seen = new Map<string, number>()
  lines.forEach((line, index) => {
    const read = readSender(line)
    if (read.error) {
      lineErrors[index] = read.error
      return
    }
    if (read.sender === null) return
    const key = senderKey(read.sender)
    if (key === '') {
      lineErrors[index] = 'Un expéditeur s’écrit avec au moins une lettre ou un chiffre.'
      return
    }
    const first = seen.get(key)
    if (first !== undefined) {
      lineErrors[index] = `Déjà dans la liste, ligne ${first + 1} : « ${list[[...seen.keys()].indexOf(key)]} ».`
      return
    }
    seen.set(key, index)
    list.push(read.sender)
  })
  const error =
    list.length > MAX_SUGGESTED_SENDERS
      ? `${list.length} expéditeurs : la liste en garde ${MAX_SUGGESTED_SENDERS} au plus. Retirez les moins utiles.`
      : undefined
  return { list, lineErrors, ...(error ? { error } : {}) }
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
