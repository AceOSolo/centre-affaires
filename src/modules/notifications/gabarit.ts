/**
 * Gabarit des courriels (ADR 080) : la mise en page commune à **tous** les
 * messages de l'application — notifications du moteur, invitations, mot de
 * passe oublié, essai d'envoi.
 *
 * Les modèles restent du texte brut (ADR 038), écrits par le centre et par
 * chaque lot qui ajoute un événement au catalogue. Le gabarit ne demande rien
 * de plus à un modèle : il lit le texte rendu et le met en page selon
 * quelques conventions que les textes suivent déjà —
 *
 * - les paragraphes sont séparés par une ligne vide ;
 * - une ligne « Libellé : https://… » vers le site devient un **bouton**
 *   portant ce libellé ; un lien seul sur sa ligne aussi ;
 * - une ligne « — » ouvre la **signature** : les lignes qui la suivent (le nom
 *   du centre) prennent les coordonnées réglées dans Configuration, et ce qui
 *   vient après une ligne vide (désinscription d'un message groupé) passe en
 *   pied de message, en petit ;
 * - toute autre adresse web ou électronique devient un lien.
 *
 * Seuls les liens vers le site lui-même (`linkOrigins`) font des boutons : un
 * lien saisi par un client dans un message ne prend pas l'allure d'une action
 * du centre.
 *
 * Le courriel part en deux parties (`multipart/alternative`) : ce HTML et le
 * texte brut, gardé tel quel avec la signature ajoutée (`withSignature`).
 *
 * Mise en page à l'ancienne, faite pour les messageries : tableaux de mise en
 * page, styles en ligne, 600 px, aucune ressource distante sinon le logo
 * servi par le site — pas de police chargée (Rubik si elle est installée,
 * sinon Arial). Couleurs de la charte (`globals.css`) : le bleu clair ne porte
 * jamais de texte (2,63:1 sur blanc), le bleu foncé porte les boutons et les
 * liens (9,49:1).
 *
 * Module pur, sans base ni Next : l'aperçu de Configuration l'exécute dans le
 * navigateur, le moteur sur le serveur (`gabarit.test.ts`).
 */

/** Ce que le centre règle pour ses courriels : son nom, son logo, sa signature. */
export type EmailBranding = {
  centreName: string
  /** Adresse absolue du logo, servie par le site ; nul : le nom du centre en tête. */
  logo: { url: string; width: number | null; height: number | null } | null
  /** Lignes de la signature, sous le nom du centre : adresse, téléphone, site. */
  signatureLines: readonly string[]
  /** Origines dont les liens deviennent des boutons : celle du site (`APP_URL`). */
  linkOrigins: readonly string[]
}

export type RenderOptions = {
  /** Aperçu dans un cadre de l'écran : les liens s'ouvrent dans un nouvel onglet. */
  preview?: boolean
}

/* Charte (`.claude/skills/secutop-brand/SKILL.md`, `src/app/globals.css`). */
const BLEU_CLAIR = '#1FABE3'
const BLEU_FONCE = '#00487B'
const TEXTE = '#1A1A1A'
const TEXTE_SECONDAIRE = '#6B7280'
const BORDURE = '#E5E9EE'
const FOND = '#F7F9FB'
const BLANC = '#FFFFFF'
/** Aucune police distante (`CLAUDE.md`) : Rubik si le poste l'a, sinon Arial. */
const POLICE = 'Rubik, Arial, Helvetica, sans-serif'

const TEXT_STYLE = `font-family:${POLICE};font-size:16px;line-height:24px;color:${TEXTE};`
const LINK_STYLE = `color:${BLEU_FONCE};text-decoration:underline;`

/* ------------------------------------------------------------------------ */
/* Lecture du texte                                                         */
/* ------------------------------------------------------------------------ */

/** Ligne qui ouvre la signature : un tiret cadratin, demi-cadratin ou `--` seul. */
const SIGNATURE_DELIMITER = /^\s*(?:—|–|--)\s*$/

/** Ponctuation collée à la fin d'une adresse, qui n'en fait pas partie. */
const TRAILING_PUNCTUATION = /[.,;:!?»)\]]+$/

export type EmailBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'button'; label: string; url: string }

export type ParsedEmailBody = {
  /** Corps du message, avant la signature. */
  blocks: EmailBlock[]
  /** Lignes qui suivent « — » (le nom du centre) ; nul : le texte n'a pas de signature. */
  signature: string[] | null
  /** Ce qui suit la signature après une ligne vide : mentions de pied de message. */
  notes: EmailBlock[]
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Index de la dernière ligne « — », ou −1. */
function delimiterIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (SIGNATURE_DELIMITER.test(lines[index])) return index
  }
  return -1
}

/** Fin des lignes de signature : la première ligne vide après « — ». */
function signatureEnd(lines: readonly string[], delimiter: number): number {
  let end = delimiter + 1
  while (end < lines.length && lines[end].trim() !== '') end++
  return end
}

function sameOrigin(url: string, origins: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && origins.includes(parsed.origin)
  } catch {
    return false
  }
}

/**
 * Libellé du bouton d'un lien seul sur sa ligne : celui du mot de passe à
 * choisir (invitation, demande du site, mot de passe oublié) se reconnaît,
 * les autres s'ouvrent.
 */
export function buttonLabelFor(url: string): string {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    return 'Ouvrir le lien'
  }
  if (/\/reset-password\//.test(path)) return 'Choisir mon mot de passe'
  if (/\/verify-email/.test(path)) return 'Confirmer mon adresse'
  return 'Ouvrir le lien'
}

/**
 * Une ligne qui fait un bouton : « Libellé : https://… » — libellé court, sans
 * deux-points, qui dit l'action — ou un lien seul, vers le site.
 */
export function buttonOf(line: string, origins: readonly string[]): { label: string; url: string } | null {
  const trimmed = line.trim()
  const lone = /^(https?:\/\/\S+)$/.exec(trimmed)
  const labelled = lone ? null : /^([^:]{1,60}?)\s*:\s*(https?:\/\/\S+)$/u.exec(trimmed)
  const raw = lone?.[1] ?? labelled?.[2]
  if (!raw) return null
  const url = raw.replace(TRAILING_PUNCTUATION, '')
  if (!sameOrigin(url, origins)) return null
  if (labelled) {
    const label = labelled[1].trim()
    if (!/\p{L}/u.test(label)) return null
    return { label, url }
  }
  return { label: buttonLabelFor(url), url }
}

/** Paragraphes séparés par des lignes vides ; un bouton est un bloc à lui seul. */
function blocksOf(lines: readonly string[], origins: readonly string[], buttons: boolean): EmailBlock[] {
  const blocks: EmailBlock[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) blocks.push({ kind: 'text', lines: current })
    current = []
  }
  for (const line of lines) {
    if (line.trim() === '') {
      flush()
      continue
    }
    const button = buttons ? buttonOf(line, origins) : null
    if (button) {
      flush()
      blocks.push({ kind: 'button', ...button })
    } else {
      current.push(line.trim())
    }
  }
  flush()
  return blocks
}

/** Lit le texte d'un message : corps, signature, pied de message. */
export function parseEmailBody(text: string, origins: readonly string[]): ParsedEmailBody {
  const lines = normalize(text).split('\n')
  const delimiter = delimiterIndex(lines)
  if (delimiter < 0) return { blocks: blocksOf(lines, origins, true), signature: null, notes: [] }
  const end = signatureEnd(lines, delimiter)
  return {
    blocks: blocksOf(lines.slice(0, delimiter), origins, true),
    signature: lines.slice(delimiter + 1, end).map((line) => line.trim()),
    // Le pied de message n'a pas de bouton : un lien de désinscription n'est
    // pas l'action du message.
    notes: blocksOf(lines.slice(end), origins, false),
  }
}

/* ------------------------------------------------------------------------ */
/* Version texte                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Le texte brut du message, signature complétée : les lignes de signature du
 * centre sous son nom, à la place où le modèle signe (« — »), ou à la fin si
 * le texte ne signe pas. Le reste est inchangé.
 */
export function withSignature(text: string, branding: EmailBranding): string {
  const lines = normalize(text).replace(/\s+$/, '').split('\n')
  const delimiter = delimiterIndex(lines)
  if (delimiter < 0) {
    return [...lines, '', '—', branding.centreName, ...branding.signatureLines].join('\n')
  }
  const end = signatureEnd(lines, delimiter)
  const named = end > delimiter + 1
  const added = named ? branding.signatureLines : [branding.centreName, ...branding.signatureLines]
  if (added.length === 0) return lines.join('\n')
  return [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n')
}

/* ------------------------------------------------------------------------ */
/* HTML                                                                     */
/* ------------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Adresse web, adresse commençant par `www.`, ou adresse électronique. */
const LINKABLE =
  /\bhttps?:\/\/[^\s<>"']+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"']*|[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi

/**
 * Texte échappé, adresses changées en liens. `compact` montre une adresse web
 * sans `https://` ni barre finale : la signature dit « www.centre.fr », le
 * corps du message montre l'adresse entière, que le lecteur voit où il va.
 */
export function linkify(text: string, options: { compact?: boolean } = {}): string {
  let html = ''
  let last = 0
  for (const match of text.matchAll(LINKABLE)) {
    const start = match.index ?? 0
    const found = match[0]
    const value = found.replace(TRAILING_PUNCTUATION, '')
    const rest = found.slice(value.length)
    let href: string
    let shown = value
    if (/^https?:\/\//i.test(value)) {
      href = value
      if (options.compact) shown = value.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    } else if (/^www\./i.test(value)) {
      href = `https://${value}`
    } else {
      href = `mailto:${value}`
    }
    html += escapeHtml(text.slice(last, start))
    html += `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(shown)}</a>${escapeHtml(rest)}`
    last = start + found.length
  }
  return html + escapeHtml(text.slice(last))
}

function paragraph(lines: readonly string[], style: string, margin: string): string {
  return `<p style="margin:${margin};${style}">${lines.map((line) => linkify(line)).join('<br>')}</p>`
}

/**
 * Bouton « à l'épreuve des messageries » : la cellule porte le fond et, pour
 * Outlook qui ignore le remplissage d'un lien, `mso-padding-alt`. Bleu foncé,
 * texte blanc (9,49:1), rayon de 12 px comme les boutons de l'application.
 */
function button(label: string, url: string): string {
  return (
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:4px 0 20px 0;border-collapse:separate;">` +
    `<tr><td align="center" bgcolor="${BLEU_FONCE}" style="border-radius:12px;background-color:${BLEU_FONCE};mso-padding-alt:12px 24px;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-family:${POLICE};font-size:16px;line-height:24px;font-weight:500;color:${BLANC};text-decoration:none;border-radius:12px;">` +
    `${escapeHtml(label)}</a></td></tr></table>`
  )
}

function blockHtml(block: EmailBlock): string {
  return block.kind === 'button'
    ? button(block.label, block.url)
    : paragraph(block.lines, `${TEXT_STYLE}word-break:break-word;`, '0 0 16px 0')
}

/** Texte d'aperçu des messageries : le début du message, sans la formule d'appel. */
function preheaderOf(blocks: readonly EmailBlock[]): string {
  const texts = blocks.flatMap((block) => (block.kind === 'text' ? [block.lines.join(' ')] : []))
  if (texts.length > 1 && /^\S+(?:\s\S+)?,$/.test(texts[0])) texts.shift()
  const text = texts.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

function header(branding: EmailBranding): string {
  const name = escapeHtml(branding.centreName)
  if (!branding.logo) {
    return `<p style="margin:0;font-family:${POLICE};font-size:22px;line-height:28px;font-weight:600;color:${BLEU_FONCE};">${name}</p>`
  }
  const { url, width, height } = branding.logo
  // Le texte alternatif est le nom du centre, stylé : Outlook bloque les
  // images par défaut, et c'est lui qui s'affiche alors.
  const alt = `font-family:${POLICE};font-size:20px;line-height:28px;font-weight:600;color:${BLEU_FONCE};`
  const size =
    width && height
      ? `width="${width}" height="${height}" style="display:block;border:0;outline:none;text-decoration:none;width:${width}px;height:${height}px;max-width:100%;${alt}"`
      : `height="56" style="display:block;border:0;outline:none;text-decoration:none;height:56px;width:auto;max-width:220px;${alt}"`
  return `<img src="${escapeHtml(url)}" alt="${name}" ${size}>`
}

function signatureHtml(parsed: ParsedEmailBody, branding: EmailBranding): string {
  const names = parsed.signature && parsed.signature.length > 0 ? parsed.signature : [branding.centreName]
  const nameHtml = names
    .map(
      (line, index) =>
        `<p style="margin:0;font-family:${POLICE};font-size:15px;line-height:22px;${index === 0 ? `font-weight:600;color:${BLEU_FONCE};` : `color:${TEXTE};`}">${linkify(line)}</p>`,
    )
    .join('')
  const lines =
    branding.signatureLines.length > 0
      ? `<p style="margin:4px 0 0 0;font-family:${POLICE};font-size:14px;line-height:21px;color:${TEXTE_SECONDAIRE};">${branding.signatureLines
          .map((line) => linkify(line, { compact: true }))
          .join('<br>')}</p>`
      : ''
  const notes = parsed.notes
    .map((block) =>
      block.kind === 'text'
        ? paragraph(
            block.lines,
            `font-family:${POLICE};font-size:13px;line-height:20px;color:${TEXTE_SECONDAIRE};word-break:break-word;`,
            '16px 0 0 0',
          )
        : '',
    )
    .join('')
  return (
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">` +
    `<tr><td style="border-top:1px solid ${BORDURE};padding-top:20px;">${nameHtml}${lines}${notes}</td></tr></table>`
  )
}

/**
 * Le message en HTML : en-tête au logo, objet en titre, corps, boutons,
 * signature. `text` est le corps rendu du modèle, **sans** les lignes de
 * signature du centre, que le gabarit place lui-même.
 */
export function renderEmailHtml(
  message: { subject: string; text: string },
  branding: EmailBranding,
  options: RenderOptions = {},
): string {
  const parsed = parseEmailBody(message.text, branding.linkOrigins)
  const subject = escapeHtml(message.subject)
  const preheader = escapeHtml(preheaderOf(parsed.blocks))
  const side = 'padding-left:40px;padding-right:40px;'

  return [
    '<!DOCTYPE html>',
    '<html lang="fr" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    // La charte n'a pas de thème sombre : les messageries qui le peuvent
    // gardent ces couleurs.
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${subject}</title>`,
    options.preview ? '<base target="_blank">' : '',
    '<style>',
    `a{color:${BLEU_FONCE};}`,
    '@media (max-width:620px){.ca-cadre{padding:0!important;}.ca-carte{border-radius:0!important;border-left:0!important;border-right:0!important;}.ca-marge{padding-left:20px!important;padding-right:20px!important;}}',
    '</style>',
    '</head>',
    `<body style="margin:0;padding:0;background-color:${FOND};-webkit-text-size-adjust:100%;">`,
    preheader
      ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>`
      : '',
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:${FOND};">`,
    `<tr><td align="center" class="ca-cadre" style="padding:32px 16px;">`,
    '<!--[if mso]><table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->',
    // Le bleu clair en filet de tête : un aplat, jamais du texte.
    `<table role="presentation" class="ca-carte" width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:${BLANC};border:1px solid ${BORDURE};border-top:4px solid ${BLEU_CLAIR};border-radius:16px;">`,
    `<tr><td class="ca-marge" style="${side}padding-top:32px;padding-bottom:8px;">${header(branding)}</td></tr>`,
    `<tr><td class="ca-marge" style="${side}padding-top:24px;padding-bottom:8px;${TEXT_STYLE}">`,
    `<h1 style="margin:0 0 20px 0;font-family:${POLICE};font-size:22px;line-height:28px;font-weight:600;color:${BLEU_FONCE};">${subject}</h1>`,
    parsed.blocks.map(blockHtml).join(''),
    '</td></tr>',
    `<tr><td class="ca-marge" style="${side}padding-top:8px;padding-bottom:32px;">${signatureHtml(parsed, branding)}</td></tr>`,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Le message aux couleurs du centre : le texte brut, signature complétée, et
 * le HTML. `text` est le corps rendu du modèle.
 */
export function brandMessage(
  message: { subject: string; text: string },
  branding: EmailBranding,
  options: RenderOptions = {},
): { text: string; html: string } {
  return { text: withSignature(message.text, branding), html: renderEmailHtml(message, branding, options) }
}
