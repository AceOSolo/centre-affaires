import { isUuid } from '../../lib/uuid.ts'
import { isValidEmail, normaliseEmail, normalisePhone } from './contacts-regles.ts'
import type { ClientStatus } from './schema.ts'

/**
 * Tiers reçus du CRM (ADR 066) : lecture de l'envoi et rapprochement avec les
 * fiches du site. Règles pures, sans base : `tiers-crm-queries.ts` les
 * applique en base.
 *
 * Le CRM fait référence pour les tiers (ADR 046) : sur une fiche qu'il tient,
 * la raison sociale, la forme juridique, le SIRET, le numéro de TVA, les
 * coordonnées, l'adresse et le statut sont les siens. Un champ absent ou nul
 * est vidé sur le site. Le reste de la fiche — notes, comptes d'accès à
 * l'espace client, courrier, réservations — reste au site.
 *
 * **Référence commune** : l'identifiant du tiers dans le CRM (`dolibarrId`),
 * gardé dans `crm_links`. Le SIRET (ou à défaut le SIREN) ne sert qu'au
 * premier rapprochement, quand le site ne connaît pas encore ce tiers ; le CRM
 * peut aussi désigner la fiche lui-même (`clientId`).
 */

export type ReceivedContact = {
  crmId: string
  fullName: string
  jobTitle: string | null
  email: string | null
  phone: string | null
  isBilling: boolean
}

export type ClientFields = {
  name: string
  legalForm: string | null
  siret: string | null
  vatNumber: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  country: string
  status: ClientStatus
}

export type ReceivedThirdParty =
  | {
      removed: true
      crmId: string
      crmRef: string | null
    }
  | {
      removed: false
      crmId: string
      crmRef: string | null
      /** Fiche du site désignée par le CRM : le rapprochement explicite. */
      clientId: string | null
      fields: ClientFields
      /** SIREN déclaré sans SIRET : il ne sert qu'au rapprochement. */
      siren: string | null
      /** Absent : les contacts du site ne changent pas. Présent : remplace ceux reçus du CRM. */
      contacts: ReceivedContact[] | undefined
      /** Ce qui a été écarté sans bloquer l'envoi : une adresse électronique illisible. */
      warnings: string[]
    }

/** Statut du tiers dans l'API, vers le statut de la fiche. */
export const thirdPartyStatuses: Record<string, ClientStatus> = {
  client: 'active',
  prospect: 'prospect',
  ferme: 'inactive',
}

/** Statut de la fiche, vers l'API. */
export const thirdPartyStatusWords: Record<ClientStatus, string> = {
  active: 'client',
  prospect: 'prospect',
  inactive: 'ferme',
}

export const MAX_CONTACTS = 200

export type Read<T> = { ok: true; value: T } | { ok: false; message: string }

/** Identifiant d'un objet du CRM : texte ou nombre, 64 caractères au plus. */
export function readCrmId(value: unknown): string | undefined {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return id && id.length <= 64 ? id : undefined
}

/** Texte facultatif, sur une ligne quand `singleLine`, coupé à `max` : il vient de l'extérieur. */
function optionalText(value: unknown, max: number, singleLine = true): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' && typeof value !== 'number') return 'invalid'
  const raw = String(value)
  const flat = (singleLine ? raw.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ') : raw).trim()
  if (!flat) return null
  return flat.length > max ? 'invalid' : flat
}

const digits = (value: string) => value.replace(/[\s.\-]/g, '')

function readEmail(value: unknown, label: string, warnings: string[]): string | null {
  const email = optionalText(value, 254)
  if (email === null) return null
  if (email === 'invalid' || !isValidEmail(normaliseEmail(email))) {
    warnings.push(`${label} illisible, non reprise.`)
    return null
  }
  return normaliseEmail(email)
}

function readPhone(value: unknown): string | null | 'invalid' {
  const phone = optionalText(value, 40)
  if (phone === null || phone === 'invalid') return phone
  // Mis en forme comme à l'écran quand c'est possible ; sinon tel quel : le
  // CRM fait foi.
  const normalised = normalisePhone(phone)
  return normalised.error ? phone : normalised.phone
}

/** Lit l'envoi `POST /api/dolibarr/tiers`. Le message dit quoi corriger. */
export function readThirdParty(body: unknown): Read<ReceivedThirdParty> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Corps illisible : un objet JSON est attendu.' }
  }
  const input = body as Record<string, unknown>
  const crmId = readCrmId(input.dolibarrId)
  if (!crmId) return { ok: false, message: '« dolibarrId » est obligatoire (64 caractères au plus).' }
  const crmRef = optionalText(input.reference, 64)
  if (crmRef === 'invalid') return { ok: false, message: '« reference » : 64 caractères au plus.' }

  if (input.supprime !== undefined && typeof input.supprime !== 'boolean') {
    return { ok: false, message: '« supprime » vaut true ou false.' }
  }
  if (input.supprime === true) return { ok: true, value: { removed: true, crmId, crmRef } }

  let clientId: string | null = null
  if (input.clientId !== undefined && input.clientId !== null) {
    if (typeof input.clientId !== 'string' || !isUuid(input.clientId)) {
      return { ok: false, message: '« clientId » : l’identifiant d’une fiche du site, tel que le site l’a donné.' }
    }
    clientId = input.clientId
  }

  if (typeof input.statut !== 'string' || !Object.hasOwn(thirdPartyStatuses, input.statut)) {
    return { ok: false, message: '« statut » vaut « client », « prospect » ou « ferme ».' }
  }
  const status = thirdPartyStatuses[input.statut]

  const name = optionalText(input.nom, 255)
  if (name === null || name === 'invalid') {
    return { ok: false, message: '« nom » est obligatoire (255 caractères au plus).' }
  }
  const legalForm = optionalText(input.formeJuridique, 100)
  if (legalForm === 'invalid') return { ok: false, message: '« formeJuridique » : 100 caractères au plus.' }

  const siretText = optionalText(input.siret, 32)
  if (siretText === 'invalid') return { ok: false, message: '« siret » : 14 chiffres.' }
  const siret = siretText === null ? null : digits(siretText)
  if (siret !== null && !/^\d{14}$/.test(siret)) return { ok: false, message: '« siret » : 14 chiffres.' }

  const sirenText = optionalText(input.siren, 32)
  if (sirenText === 'invalid') return { ok: false, message: '« siren » : 9 chiffres.' }
  const siren = sirenText === null ? null : digits(sirenText)
  if (siren !== null && !/^\d{9}$/.test(siren)) return { ok: false, message: '« siren » : 9 chiffres.' }
  if (siret && siren && !siret.startsWith(siren)) {
    return { ok: false, message: '« siret » et « siren » ne désignent pas la même entreprise.' }
  }

  const vatText = optionalText(input.numeroTva, 32)
  if (vatText === 'invalid') return { ok: false, message: '« numeroTva » : 32 caractères au plus.' }
  const vatNumber = vatText === null ? null : vatText.replace(/[\s.]/g, '').toUpperCase()

  const warnings: string[] = []
  const email = readEmail(input.email, 'Adresse électronique du tiers', warnings)
  const phone = readPhone(input.telephone)
  if (phone === 'invalid') return { ok: false, message: '« telephone » : 40 caractères au plus.' }

  const address = input.adresse
  if (address !== undefined && address !== null && (typeof address !== 'object' || Array.isArray(address))) {
    return { ok: false, message: '« adresse » est un objet : ligne1, ligne2, codePostal, ville, pays.' }
  }
  const a = (address ?? {}) as Record<string, unknown>
  const addressLine1 = optionalText(a.ligne1, 255)
  const addressLine2 = optionalText(a.ligne2, 255)
  const postalCode = optionalText(a.codePostal, 20)
  const city = optionalText(a.ville, 120)
  if ([addressLine1, addressLine2, postalCode, city].includes('invalid')) {
    return { ok: false, message: '« adresse » : lignes de 255 caractères au plus, code postal de 20, ville de 120.' }
  }
  const countryText = optionalText(a.pays, 2)
  if (countryText === 'invalid' || (countryText !== null && !/^[A-Za-z]{2}$/.test(countryText))) {
    return { ok: false, message: '« adresse.pays » : le code ISO à deux lettres (FR, BE…).' }
  }

  let contacts: ReceivedContact[] | undefined
  if (input.contacts !== undefined && input.contacts !== null) {
    if (!Array.isArray(input.contacts)) return { ok: false, message: '« contacts » est une liste.' }
    if (input.contacts.length > MAX_CONTACTS) {
      return { ok: false, message: `« contacts » : ${MAX_CONTACTS} au plus.` }
    }
    contacts = []
    const seen = new Set<string>()
    for (const [index, raw] of input.contacts.entries()) {
      const where = `« contacts[${index}] »`
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: `${where} est un objet.` }
      const contact = raw as Record<string, unknown>
      const contactId = readCrmId(contact.dolibarrId)
      if (!contactId) return { ok: false, message: `${where} : « dolibarrId » est obligatoire.` }
      if (seen.has(contactId)) return { ok: false, message: `${where} : le contact ${contactId} figure deux fois.` }
      seen.add(contactId)
      const fullName = optionalText(contact.nom, 255)
      if (fullName === null || fullName === 'invalid') {
        return { ok: false, message: `${where} : « nom » est obligatoire (255 caractères au plus).` }
      }
      const jobTitle = optionalText(contact.fonction, 255)
      if (jobTitle === 'invalid') return { ok: false, message: `${where} : « fonction » : 255 caractères au plus.` }
      const contactPhone = readPhone(contact.telephone)
      if (contactPhone === 'invalid') return { ok: false, message: `${where} : « telephone » : 40 caractères au plus.` }
      if (contact.facturation !== undefined && typeof contact.facturation !== 'boolean') {
        return { ok: false, message: `${where} : « facturation » vaut true ou false.` }
      }
      contacts.push({
        crmId: contactId,
        fullName,
        jobTitle,
        email: readEmail(contact.email, `Adresse électronique du contact ${contactId}`, warnings),
        phone: contactPhone,
        isBilling: contact.facturation === true,
      })
    }
  }

  return {
    ok: true,
    value: {
      removed: false,
      crmId,
      crmRef,
      clientId,
      siren: siret ? null : siren,
      fields: {
        name,
        legalForm,
        siret,
        vatNumber,
        email,
        phone,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        country: (countryText ?? 'FR').toUpperCase(),
        status,
      },
      contacts,
      warnings,
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Rapprochement                                                            */
/* ------------------------------------------------------------------------ */

/** Une fiche du site, telle que le rapprochement la voit. */
export type ClientCandidate = {
  clientId: string
  name: string
  archived: boolean
  anonymized: boolean
  /** Tiers du CRM auquel la fiche est déjà reliée, s'il y en a un. */
  linkedTo: string | null
}

export type MatchCandidates = {
  /** La fiche déjà reliée à ce tiers. */
  linked: ClientCandidate | null
  /** La fiche désignée par `clientId` ; `missing` si elle n'existe pas dans ce centre. */
  explicit: ClientCandidate | 'missing' | null
  /** Fiches vivantes au même SIRET (au plus une : index unique). */
  bySiret: ClientCandidate[]
  /** Fiches vivantes dont le SIRET commence par ce SIREN. */
  bySiren: ClientCandidate[]
}

export type MatchDecision =
  | { kind: 'update'; clientId: string; how: 'link' | 'explicit' | 'siret' | 'siren' }
  | { kind: 'create' }
  | { kind: 'remove'; clientId: string }
  | { kind: 'ignore'; clientId: string | null; message: string }
  | { kind: 'refuse'; status: 404 | 409; message: string }

/**
 * À quelle fiche du site ce tiers correspond, dans l'ordre :
 *
 * 1. celle qui lui est déjà reliée — sa référence commune ;
 * 2. celle que le CRM désigne (`clientId`) ;
 * 3. la seule fiche vivante, non reliée, au même SIRET ;
 * 4. la seule fiche vivante, non reliée, au même SIREN ;
 * 5. aucune : un client est créé ; un prospect ou un tiers fermé ne l'est pas
 *    — le site n'a que faire des prospects du CRM tant qu'ils ne sont pas
 *    clients.
 *
 * Jamais deux tiers pour une fiche, ni deux fiches pour un tiers. Une fiche
 * anonymisée (RGPD) ou archivée ne se met plus à jour.
 *
 * Les messages désignent les fiches par leur identifiant, jamais par leur
 * nom : ils vont au journal des échanges, qui ne porte pas de donnée
 * personnelle (ADR 065 § 10).
 */
export function decideThirdPartyMatch(input: ReceivedThirdParty, candidates: MatchCandidates): MatchDecision {
  const { linked } = candidates
  if (input.removed) {
    return linked
      ? { kind: 'remove', clientId: linked.clientId }
      : { kind: 'ignore', clientId: null, message: 'Tiers inconnu du site : rien à retirer.' }
  }

  const frozen = (candidate: ClientCandidate): string | undefined =>
    candidate.anonymized
      ? `La fiche ${candidate.clientId} est anonymisée (RGPD) : elle ne se met plus à jour.`
      : candidate.archived
        ? `La fiche ${candidate.clientId} est archivée sur le site : elle ne se met plus à jour.`
        : undefined

  if (linked) {
    if (input.clientId && input.clientId !== linked.clientId) {
      return {
        kind: 'refuse',
        status: 409,
        message: `Ce tiers est déjà rapproché de la fiche ${linked.clientId} du site, pas de ${input.clientId}.`,
      }
    }
    const why = frozen(linked)
    return why ? { kind: 'ignore', clientId: linked.clientId, message: why } : { kind: 'update', clientId: linked.clientId, how: 'link' }
  }

  const { explicit } = candidates
  if (input.clientId) {
    if (!explicit || explicit === 'missing') {
      return { kind: 'refuse', status: 404, message: `Aucune fiche du site n’a l’identifiant ${input.clientId}.` }
    }
    const why = frozen(explicit)
    if (why) return { kind: 'refuse', status: 409, message: why }
    if (explicit.linkedTo) {
      return {
        kind: 'refuse',
        status: 409,
        message: `La fiche ${explicit.clientId} est déjà rapprochée du tiers ${explicit.linkedTo} : un doublon dans le CRM ?`,
      }
    }
    return { kind: 'update', clientId: explicit.clientId, how: 'explicit' }
  }

  const usable = (list: ClientCandidate[]) => list.filter((c) => !c.archived && !c.anonymized)
  const siret = usable(candidates.bySiret)
  if (siret.length > 0) {
    const [match] = siret
    if (match.linkedTo) {
      return {
        kind: 'refuse',
        status: 409,
        message: `Le SIRET ${input.fields.siret} est celui de la fiche ${match.clientId}, déjà rapprochée du tiers ${match.linkedTo} : un doublon dans le CRM ?`,
      }
    }
    return { kind: 'update', clientId: match.clientId, how: 'siret' }
  }

  const siren = usable(candidates.bySiren).filter((c) => !c.linkedTo)
  if (siren.length === 1) return { kind: 'update', clientId: siren[0].clientId, how: 'siren' }
  if (siren.length > 1) {
    return {
      kind: 'refuse',
      status: 409,
      message: `Plusieurs fiches du site portent ce SIREN (${siren.map((c) => c.clientId).join(', ')}) : envoyer « clientId » pour désigner la bonne.`,
    }
  }

  if (input.fields.status !== 'active') {
    return {
      kind: 'ignore',
      clientId: null,
      message:
        input.fields.status === 'prospect'
          ? 'Prospect sans fiche sur le site : rien n’est créé tant qu’il n’est pas client.'
          : 'Tiers fermé sans fiche sur le site : rien n’est créé.',
    }
  }
  return { kind: 'create' }
}

/** Les champs que le CRM tient ont-ils changé sur cette fiche ? */
export function clientFieldsChanged(current: ClientFields, received: ClientFields): boolean {
  return (Object.keys(received) as (keyof ClientFields)[]).some((key) => (current[key] ?? null) !== (received[key] ?? null))
}

/* ------------------------------------------------------------------------ */
/* Contacts                                                                 */
/* ------------------------------------------------------------------------ */

export type ContactFields = Omit<ReceivedContact, 'crmId'>

/** Un contact du site relié à un contact du CRM. */
export type LinkedContact = {
  contactId: string
  crmId: string
  /** Retiré de la fiche sur le site (`deleted_at`) ; anonymisé : ne revient jamais. */
  archived: boolean
  anonymized: boolean
  current: ContactFields
}

export type ContactPlan = {
  create: ReceivedContact[]
  update: { contactId: string; contact: ReceivedContact; revive: boolean }[]
  remove: string[]
}

/**
 * Les contacts reçus remplacent ceux que le CRM avait envoyés pour ce tiers :
 * nouveaux créés, connus mis à jour (ou remis sur la fiche s'ils en avaient
 * été retirés), absents retirés (`deleted_at`). Les contacts saisis sur le
 * site, sans lien avec le CRM, ne bougent pas. Le contact principal reste un
 * choix du site.
 */
export function planContacts(received: readonly ReceivedContact[], linked: readonly LinkedContact[]): ContactPlan {
  const byCrmId = new Map(linked.map((contact) => [contact.crmId, contact]))
  const plan: ContactPlan = { create: [], update: [], remove: [] }
  for (const contact of received) {
    const known = byCrmId.get(contact.crmId)
    if (!known) {
      plan.create.push(contact)
      continue
    }
    if (known.anonymized) continue
    const fields: ContactFields = {
      fullName: contact.fullName,
      jobTitle: contact.jobTitle,
      email: contact.email,
      phone: contact.phone,
      isBilling: contact.isBilling,
    }
    const changed = (Object.keys(fields) as (keyof ContactFields)[]).some(
      (key) => (known.current[key] ?? null) !== (fields[key] ?? null),
    )
    if (changed || known.archived) plan.update.push({ contactId: known.contactId, contact, revive: known.archived })
  }
  const kept = new Set(received.map((contact) => contact.crmId))
  for (const contact of linked) {
    if (!kept.has(contact.crmId) && !contact.archived) plan.remove.push(contact.contactId)
  }
  return plan
}
