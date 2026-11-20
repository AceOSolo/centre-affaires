import { addDaysToIsoDate, formatCalendarDate, toIsoDate } from '../../lib/dates.ts'
import type { DolibarrClient } from '../crm/dolibarr-api.ts'
import { centsToDecimal, type DolibarrProposal } from './propositions.ts'

/**
 * Le devis du site tel que Dolibarr le reçoit à `POST /proposals` (ADR 073) :
 * règles pures, sans réseau ni base.
 *
 * Le corps suit le modèle JSON du centre : tiers (`socid`), contact
 * (`contactid`), dates du jour, fin de validité, lignes, et les champs
 * complémentaires (`array_options`, les `options_*` de Dolibarr).
 *
 * Les dates sont celles du jour de la demande, au fuseau du centre
 * (décision 4) : un envoi repris le lendemain après une coupure garde la date
 * à laquelle le demandeur a écrit.
 */

/** Durée de validité d'un devis, en jours, à partir du jour de la demande. */
export const QUOTE_VALIDITY_DAYS = 90

/** Valeur d'un champ complémentaire de Dolibarr (`options_*`). */
export type ExtrafieldValue = string | number | boolean | null
export type QuoteExtrafields = Record<string, ExtrafieldValue>

/**
 * Le réglage tel qu'il est enregistré : les champs du devis à plat, et deux
 * rubriques facultatives, `contact` et `tiers`, pour les champs obligatoires
 * que le Dolibarr du centre impose aussi à la création d'un contact ou d'un tiers.
 */
export type StoredExtrafields = Record<string, ExtrafieldValue | QuoteExtrafields>

/** Les trois jeux de champs, une fois le réglage séparé. */
export type ExtrafieldSettings = { proposal: QuoteExtrafields; contact: QuoteExtrafields; thirdparty: QuoteExtrafields }

/**
 * Ce que le site envoie quand la direction n'a rien réglé pour un des trois
 * objets : les codes du Dolibarr de ce centre (listes « mode », « typage devis »,
 * « origine du contact »…). Ils sont propres à son Dolibarr : un second centre
 * remplira ses champs à l'écran, et un champ rempli remplace entièrement le
 * défaut de son objet (ADR 073).
 */
export const DEFAULT_EXTRAFIELD_SETTINGS: ExtrafieldSettings = {
  proposal: {
    options_typage_devis: '1',
    options_mode: '3',
    options_origine_dde: "Site du centre d'affaires",
    options_demande_date_planning: '1',
  },
  contact: { options_origine_contact: '60' },
  thirdparty: { options_potential: '4', options_invoiceable: '4', options_ori_contact: '60' },
}

const MAX_EXTRAFIELDS = 40
const MAX_EXTRAFIELD_TEXT = 1000
const EXTRAFIELD_KEY = /^options_[a-z0-9_]{1,60}$/

/**
 * Les champs complémentaires que la direction règle pour son Dolibarr, pour un
 * des trois objets : un objet JSON
 * `{ "options_origine_dde": "centre", "options_typage_devis": 1 }`.
 * Ce sont des codes de ses listes (« qui indique le statut », « mode »…) :
 * le site ne peut pas les deviner, il les recopie. Pour le devis, ils l'emportent
 * sur ceux que le site calcule (`defaultExtrafields`).
 */
export function parseQuoteExtrafields(text: string): { ok: true; value: QuoteExtrafields } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, message: 'JSON illisible : attendu { "options_champ": valeur, … }.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'Attendu un objet JSON : { "options_champ": valeur, … }.' }
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length > MAX_EXTRAFIELDS) return { ok: false, message: `${MAX_EXTRAFIELDS} champs au plus.` }
  const value: QuoteExtrafields = {}
  for (const [key, field] of entries) {
    if (!EXTRAFIELD_KEY.test(key)) {
      return { ok: false, message: `« ${key.slice(0, 60)} » : un champ complémentaire s'écrit « options_ » suivi de son nom, en minuscules.` }
    }
    const scalar = field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))
    if (!scalar && !(typeof field === 'string' && field.length <= MAX_EXTRAFIELD_TEXT)) {
      return { ok: false, message: `« ${key} » : une valeur simple (texte de ${MAX_EXTRAFIELD_TEXT} caractères au plus, nombre, vrai/faux ou null).` }
    }
    value[key] = field as ExtrafieldValue
  }
  return { ok: true, value }
}

/** Assemble les trois réglages de l'écran pour l'enregistrement : le devis à plat, puis `contact` et `tiers` s'ils sont remplis. */
export function joinExtrafieldSettings(settings: ExtrafieldSettings): StoredExtrafields {
  return {
    ...settings.proposal,
    ...(Object.keys(settings.contact).length > 0 ? { contact: settings.contact } : {}),
    ...(Object.keys(settings.thirdparty).length > 0 ? { tiers: settings.thirdparty } : {}),
  }
}

/** Sépare le réglage enregistré en champs de devis, de contact et de tiers, sans les défauts. */
export function readExtrafieldSettings(stored: StoredExtrafields): ExtrafieldSettings {
  const proposal: QuoteExtrafields = {}
  for (const [key, field] of Object.entries(stored)) {
    if (key !== 'contact' && key !== 'tiers') proposal[key] = field as ExtrafieldValue
  }
  const section = (name: 'contact' | 'tiers'): QuoteExtrafields => {
    const value = stored[name]
    return value && typeof value === 'object' ? value : {}
  }
  return { proposal, contact: section('contact'), thirdparty: section('tiers') }
}

/** Ce qui part vraiment : le réglage de chaque objet, ou son défaut quand il n'a rien réglé. */
export function splitExtrafieldSettings(stored: StoredExtrafields): ExtrafieldSettings {
  const set = readExtrafieldSettings(stored)
  const orDefault = (value: QuoteExtrafields, fallback: QuoteExtrafields) => (Object.keys(value).length > 0 ? value : fallback)
  return {
    proposal: orDefault(set.proposal, DEFAULT_EXTRAFIELD_SETTINGS.proposal),
    contact: orDefault(set.contact, DEFAULT_EXTRAFIELD_SETTINGS.contact),
    thirdparty: orDefault(set.thirdparty, DEFAULT_EXTRAFIELD_SETTINGS.thirdparty),
  }
}

/** Ce que le site sait du centre pour remplir le devis. */
export type QuoteSite = { timeZone: string; city: string | null; postalCode: string | null }

const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** « Période souhaitée » en une phrase, pour la note de planning. */
function wantedPeriod(proposal: DolibarrProposal, timeZone: string): { from: string; to: string } | undefined {
  if (proposal.reservation) {
    return {
      from: toIsoDate(new Date(proposal.reservation.debut), timeZone),
      to: toIsoDate(new Date(proposal.reservation.fin), timeZone),
    }
  }
  const start = proposal.reponsesBrutes.debut
  return typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start) ? { from: start, to: start } : undefined
}

/**
 * Ce que le site calcule : les dates de la demande, le lieu (le centre), la
 * période souhaitée, le nombre de participants, et le détail de la demande en
 * clair pour l'accueil. Les codes propres au Dolibarr du centre n'y sont pas.
 */
export function defaultExtrafields(proposal: DolibarrProposal, site: QuoteSite): QuoteExtrafields {
  const day = toIsoDate(new Date(proposal.creeLe), site.timeZone)
  const period = wantedPeriod(proposal, site.timeZone)
  const participants = number(proposal.reponsesBrutes.participants)

  const detail = [
    `Message du demandeur : ${proposal.message?.trim() || 'aucun'}`,
    ...proposal.reponses.map(({ libelle, valeur }) => `${libelle} : ${valeur}`),
    ...(proposal.reservation
      ? [`Réservation : ${proposal.reservation.ressource}, du ${formatCalendarDate(period!.from)} au ${formatCalendarDate(period!.to)}`]
      : period
        ? [`À partir du : ${formatCalendarDate(period.from)}`]
        : []),
    `Demande du site : ${proposal.reference}`,
  ].join('\n')

  const fields: QuoteExtrafields = {
    options_date_dde: day,
    options_date_dde_client: day,
    options_datretsouh: day,
    options_preciplanning: detail,
  }
  if (site.city) fields.options_ville = site.city
  if (site.postalCode) fields.options_code_postal_lieu_intervention = site.postalCode
  if (period) {
    fields.options_dateapartir = period.from
    fields.options_dateavant = period.to
  }
  if (participants !== undefined) fields.options_nb_participant = participants
  return fields
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Texte du site en HTML simple, comme l'éditeur de Dolibarr le tient : retours à la ligne en `<br />`. */
export function toDolibarrHtml(text: string): string {
  return escapeHtml(text.trim()).replace(/\r?\n/g, '<br />\r\n')
}

/** TVA « 20.000 », trois décimales comme Dolibarr les écrit. */
function vatText(percent: string): string {
  return Number(percent).toFixed(3)
}

export type ProposalLineBody = Record<string, string | number>

/**
 * Les lignes de la proposition. `productIds` : identifiant Dolibarr du
 * produit de chaque ligne (par position), quand il a été retrouvé.
 *
 * Le prix est toujours celui du devis (le prix annoncé au demandeur, ADR 023),
 * même quand la ligne vise un produit de Dolibarr : Dolibarr ne le complète
 * pas à la création par l'API, et le facturer autrement que le devis serait
 * une erreur. La remise en montant devient une ligne de remise négative, la
 * proposition de Dolibarr n'ayant qu'une remise en pourcentage.
 */
export function buildProposalLines(proposal: DolibarrProposal, productIds: ReadonlyMap<number, string>): ProposalLineBody[] {
  const lines: ProposalLineBody[] = []
  for (const line of proposal.lignes) {
    const productId = productIds.get(line.position)
    const description = line.description?.trim()
    const body: ProposalLineBody = {
      product_type: String(line.typeProduit),
      qty: line.quantite,
      subprice: line.prixUnitaireHt,
      tva_tx: vatText(line.tauxTva),
    }
    if (productId) {
      body.fk_product = productId
      body.label = line.designation
      if (description) body.desc = toDolibarrHtml(description)
    } else {
      // Sans produit, la désignation est la description de la ligne.
      body.desc = toDolibarrHtml(description ? `${line.designation}\n${description}` : line.designation)
    }
    if (line.remisePourcent !== null) body.remise_percent = line.remisePourcent
    lines.push(body)
    if (line.remiseMontantCentimes) {
      lines.push({
        product_type: String(line.typeProduit),
        qty: line.quantite,
        subprice: centsToDecimal(-line.remiseMontantCentimes),
        tva_tx: vatText(line.tauxTva),
        desc: toDolibarrHtml(`Remise — ${line.designation}`),
      })
    }
  }
  return lines
}

export type ProposalBodyContext = {
  /** Identifiant Dolibarr du tiers et, s'il y en a un, du contact. */
  socid: string
  contactId: string | null
  productIds: ReadonlyMap<number, string>
  site: QuoteSite
  /** Champs complémentaires réglés par la direction : ils l'emportent sur ceux du site. */
  extrafields: QuoteExtrafields
}

/** Le corps de `POST /proposals`. */
export function buildProposalBody(proposal: DolibarrProposal, context: ProposalBodyContext): Record<string, unknown> {
  const day = toIsoDate(new Date(proposal.creeLe), context.site.timeZone)
  const body: Record<string, unknown> = {
    socid: context.socid,
    ...(context.contactId ? { contactid: context.contactId } : {}),
    // Rend la création rejouable : on cherche d'abord cette référence (`dolibarr-api.ts`).
    ref_client: proposal.reference,
    datec: day,
    date: day,
    date_creation: day,
    datev: day,
    date_validation: day,
    fin_validite: addDaysToIsoDate(day, QUOTE_VALIDITY_DAYS),
    lines: buildProposalLines(proposal, context.productIds),
    array_options: { ...defaultExtrafields(proposal, context.site), ...context.extrafields },
  }
  if (proposal.noteAccueil?.trim()) body.note_private = proposal.noteAccueil.trim()
  return body
}

const DIGITS = /\D/g

/** SIRET (14 chiffres) ou SIREN (9), tels que Dolibarr les range : `idprof2` et `idprof1`. */
export function splitCompanyId(value: string | null): { siret: string | null; siren: string | null } {
  const digits = (value ?? '').replace(DIGITS, '')
  if (digits.length === 14) return { siret: digits, siren: digits.slice(0, 9) }
  if (digits.length === 9) return { siret: null, siren: digits }
  return { siret: null, siren: null }
}

/** Le corps de `POST /thirdparties` : un prospect (`client` = 2), que l'accueil transformera en client à la signature. */
export function buildThirdpartyBody(proposal: DolibarrProposal, extrafields: QuoteExtrafields = {}): Record<string, unknown> {
  const { tiers } = proposal
  const { siret, siren } = splitCompanyId(tiers.siret)
  const address = tiers.adresse
  const street = [address?.ligne1, address?.ligne2].filter(Boolean).join('\n')
  return {
    name: tiers.nom,
    client: '2',
    // Dolibarr numérote seul selon son modèle de codes.
    code_client: 'auto',
    status: '1',
    ...(tiers.email ? { email: tiers.email } : {}),
    ...(tiers.telephone ? { phone: tiers.telephone } : {}),
    ...(street ? { address: street } : {}),
    ...(address?.codePostal ? { zip: address.codePostal } : {}),
    ...(address?.ville ? { town: address.ville } : {}),
    ...(address ? { country_code: address.pays } : {}),
    ...(siret ? { idprof2: siret } : {}),
    ...(siren ? { idprof1: siren } : {}),
    ...(tiers.numeroTva ? { tva_intra: tiers.numeroTva } : {}),
    ...(Object.keys(extrafields).length > 0 ? { array_options: extrafields } : {}),
  }
}

/** Nom du contact en prénom + nom : « Claire Martin » devient `firstname` et `lastname`. */
export function splitContactName(name: string): { firstname: string; lastname: string } {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { firstname: '', lastname: words[0] ?? '' }
  return { firstname: words[0]!, lastname: words.slice(1).join(' ') }
}

/** Le corps de `POST /contacts`, ou `undefined` si le demandeur n'a laissé ni nom ni adresse. */
export function buildContactBody(
  proposal: DolibarrProposal,
  socid: string,
  extrafields: QuoteExtrafields = {},
): Record<string, unknown> | undefined {
  const { contact } = proposal
  const name = contact.nom?.trim() || contact.email?.trim()
  if (!name) return undefined
  const { firstname, lastname } = contact.nom?.trim() ? splitContactName(contact.nom) : { firstname: '', lastname: name }
  return {
    socid,
    lastname,
    ...(firstname ? { firstname } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.telephone ? { phone_pro: contact.telephone } : {}),
    statut: '1',
    ...(Object.keys(extrafields).length > 0 ? { array_options: extrafields } : {}),
  }
}

// --- L'enchaînement des appels ---------------------------------------------

export type SentProposal = {
  dolibarrId: string
  dolibarrRef: string | null
  /** La proposition existait déjà (envoi interrompu puis rejoué) : rien n'a été recréé. */
  reused: boolean
  /** Le contact n'a pas pu être rattaché ; la proposition est créée. */
  warning: string | null
}

export async function sendProposalToDolibarr(
  client: DolibarrClient,
  proposal: DolibarrProposal,
  options: {
    site: QuoteSite
    extrafields: QuoteExtrafields
    /** Champs obligatoires du Dolibarr du centre pour un contact et pour un tiers créés par le site. */
    contactExtrafields?: QuoteExtrafields
    thirdpartyExtrafields?: QuoteExtrafields
    linkedThirdpartyId?: string | null
  },
): Promise<SentProposal> {
  // Un envoi interrompu après la création ne doit pas la doubler.
  const existing = await client.findProposalByClientRef(proposal.reference)
  if (existing) return { dolibarrId: existing.id, dolibarrRef: existing.ref, reused: true, warning: null }

  const { siret, siren } = splitCompanyId(proposal.tiers.siret)
  const socid =
    options.linkedThirdpartyId ||
    (await client.findThirdparty({ siret, siren, email: proposal.tiers.email })) ||
    (await client.createThirdparty(buildThirdpartyBody(proposal, options.thirdpartyExtrafields)))

  let contactId: string | null = null
  const contactBody = buildContactBody(proposal, socid, options.contactExtrafields)
  if (contactBody) {
    const email = proposal.contact.email
    contactId = (email ? await client.findContact(socid, email) : undefined) ?? (await client.createContact(contactBody))
  }

  // Chaque produit n'est cherché qu'une fois, même si plusieurs lignes le portent.
  const found = new Map<string, string | undefined>()
  const productIds = new Map<number, string>()
  for (const line of proposal.lignes) {
    for (const ref of line.produitRefs) {
      if (!found.has(ref)) found.set(ref, await client.findProductId(ref))
      const id = found.get(ref)
      if (id) {
        productIds.set(line.position, id)
        break
      }
    }
  }

  const dolibarrId = await client.createProposal(
    buildProposalBody(proposal, { socid, contactId, productIds, site: options.site, extrafields: options.extrafields }),
  )

  let warning: string | null = null
  if (contactId) {
    try {
      await client.linkProposalContact(dolibarrId, contactId)
    } catch (error) {
      // La proposition existe : la refaire la doublerait. Le contact se rattache à la main.
      warning = `Contact non rattaché : ${error instanceof Error ? error.message : 'erreur inconnue'}`
    }
  }
  const dolibarrRef = await client.proposalRef(dolibarrId).catch(() => null)
  return { dolibarrId, dolibarrRef, reused: false, warning }
}
