import { and, asc, eq, gt, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm'

import { DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import type { Transaction } from '../../db/index.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { CrmConnectorId } from '../crm/connecteurs.ts'
import { crmLinks } from '../crm/schema-liens.ts'
import { clientContacts, clients } from './schema.ts'
import {
  clientFieldsChanged,
  decideThirdPartyMatch,
  planContacts,
  thirdPartyStatusWords,
  type ClientCandidate,
  type ClientFields,
  type LinkedContact,
  type ReceivedContact,
  type ReceivedThirdParty,
} from './tiers-crm.ts'

/**
 * Tiers reçus du CRM, en base (ADR 066). Une seule transaction par envoi :
 * la fiche, son lien avec le CRM et ses contacts changent ensemble ou pas du
 * tout. Chaque lecture porte son filtre `tenant_id` (décision 1).
 */

export type ThirdPartyOutcome =
  | {
      result: 'cree' | 'rapproche' | 'modifie' | 'inchange' | 'retire' | 'ignore'
      clientId: string | null
      message: string
      warnings: string[]
    }
  | { result: 'refuse'; status: 404 | 409; message: string }

const candidateColumns = {
  clientId: clients.id,
  name: clients.name,
  deletedAt: clients.deletedAt,
  anonymizedAt: clients.anonymizedAt,
}

/** Fiches du centre, avec le tiers du CRM auquel chacune est déjà reliée. */
async function candidates(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  where: ReturnType<typeof and>,
): Promise<ClientCandidate[]> {
  const rows = await tx
    .select({ ...candidateColumns, linkedTo: crmLinks.externalId })
    .from(clients)
    .leftJoin(
      crmLinks,
      and(
        eq(crmLinks.tenantId, clients.tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'client'),
        eq(crmLinks.localId, clients.id),
        isNull(crmLinks.removedAt),
      ),
    )
    .where(and(eq(clients.tenantId, tenantId), where))
  return rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    archived: row.deletedAt !== null,
    anonymized: row.anonymizedAt !== null,
    linkedTo: row.linkedTo,
  }))
}

const fieldColumns = {
  name: clients.name,
  legalForm: clients.legalForm,
  siret: clients.siret,
  vatNumber: clients.vatNumber,
  email: clients.email,
  phone: clients.phone,
  addressLine1: clients.addressLine1,
  addressLine2: clients.addressLine2,
  postalCode: clients.postalCode,
  city: clients.city,
  country: clients.country,
  status: clients.status,
}

/**
 * Reçoit un tiers : le rapproche d'une fiche du site, ou en crée une, et
 * reprend ce que le CRM en tient. Rejouable : le même envoi une seconde fois
 * répond « inchangé ».
 */
export async function receiveThirdParty(connector: CrmConnectorId, input: ReceivedThirdParty): Promise<ThirdPartyOutcome> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, (tx) => applyThirdParty(tx, tenantId, connector, input))
  } catch (error) {
    // Deux envois simultanés du même tiers : le second bute sur l'index unique
    // du lien ou du SIRET. Le rejouer suffit.
    if (dbErrorCode(error) === DB_UNIQUE_VIOLATION) {
      return {
        result: 'refuse',
        status: 409,
        message: 'Le tiers vient d’être reçu par un autre envoi, ou son SIRET est déjà pris : rejouer l’envoi.',
      }
    }
    throw error
  }
}

async function applyThirdParty(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  input: ReceivedThirdParty,
): Promise<ThirdPartyOutcome> {
  const [link] = await tx
    .select({ id: crmLinks.id, localId: crmLinks.localId, removedAt: crmLinks.removedAt })
    .from(crmLinks)
    .where(
      and(
        eq(crmLinks.tenantId, tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'client'),
        eq(crmLinks.externalId, input.crmId),
      ),
    )
    .for('update')
  const liveLink = link && !link.removedAt ? link : undefined

  const linked = liveLink ? ((await candidates(tx, tenantId, connector, eq(clients.id, liveLink.localId)))[0] ?? null) : null
  let explicit: ClientCandidate | 'missing' | null = null
  let bySiret: ClientCandidate[] = []
  let bySiren: ClientCandidate[] = []
  if (!input.removed && !linked) {
    if (input.clientId) {
      explicit = (await candidates(tx, tenantId, connector, eq(clients.id, input.clientId)))[0] ?? 'missing'
    } else {
      if (input.fields.siret) {
        bySiret = await candidates(tx, tenantId, connector, and(eq(clients.siret, input.fields.siret), isNull(clients.deletedAt)))
      }
      const siren = input.fields.siret?.slice(0, 9) ?? input.siren
      if (bySiret.length === 0 && siren) {
        bySiren = await candidates(tx, tenantId, connector, and(like(clients.siret, `${siren}%`), isNull(clients.deletedAt)))
      }
    }
  }

  const decision = decideThirdPartyMatch(input, { linked, explicit, bySiret, bySiren })
  switch (decision.kind) {
    case 'refuse':
      return { result: 'refuse', status: decision.status, message: decision.message }
    case 'ignore':
      return {
        result: 'ignore',
        clientId: decision.clientId,
        message: decision.message,
        warnings: input.removed ? [] : input.warnings,
      }
    case 'remove':
      await tx
        .update(crmLinks)
        .set({ removedAt: sql`CURRENT_TIMESTAMP(3)`, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
        .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, liveLink!.id)))
      return {
        result: 'retire',
        clientId: decision.clientId,
        message: 'Tiers supprimé dans le CRM : la fiche reste sur le site, elle n’est plus tenue par le CRM.',
        warnings: [],
      }
  }
  if (input.removed) throw new Error('Inatteignable : un tiers supprimé est retiré ou ignoré.')

  // Le SIRET est unique parmi les fiches vivantes du centre : le dire avant
  // que l'index ne le refuse.
  const target = decision.kind === 'update' ? decision.clientId : null
  if (input.fields.siret) {
    const [taken] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.tenantId, tenantId),
          eq(clients.siret, input.fields.siret),
          isNull(clients.deletedAt),
          target ? ne(clients.id, target) : undefined,
        ),
      )
      .limit(1)
    if (taken) {
      return {
        result: 'refuse',
        status: 409,
        message: `Le SIRET ${input.fields.siret} est déjà celui de la fiche ${taken.id} du site : rapprocher ce tiers de cette fiche (« clientId »), ou corriger le SIRET dans le CRM.`,
      }
    }
  }

  let clientId: string
  let changed: boolean
  if (decision.kind === 'create') {
    clientId = uuidv7()
    await tx.insert(clients).values({ id: clientId, tenantId, ...input.fields })
    changed = true
  } else {
    clientId = decision.clientId
    const [current] = await tx
      .select(fieldColumns)
      .from(clients)
      .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
      .for('update')
    changed = clientFieldsChanged(current as ClientFields, input.fields)
    if (changed) {
      await tx
        .update(clients)
        .set(input.fields)
        .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    }
  }

  if (liveLink) {
    await tx
      .update(crmLinks)
      .set({ externalRef: input.crmRef, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, liveLink.id)))
  } else if (link) {
    // Un tiers supprimé dans le CRM qui revient : son lien reprend.
    await tx
      .update(crmLinks)
      .set({ localId: clientId, externalRef: input.crmRef, removedAt: null, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, link.id)))
  } else {
    await tx.insert(crmLinks).values({
      tenantId,
      connector,
      entity: 'client',
      localId: clientId,
      externalId: input.crmId,
      externalRef: input.crmRef,
    })
  }

  const warnings = [...input.warnings]
  const contactsChanged = input.contacts
    ? await applyContacts(tx, tenantId, connector, clientId, input.contacts, warnings)
    : false

  if (decision.kind === 'create') {
    return { result: 'cree', clientId, message: 'Fiche créée sur le site.', warnings }
  }
  if (decision.how !== 'link') {
    const how = { explicit: 'désignée par le CRM', siret: 'au même SIRET', siren: 'au même SIREN' }[decision.how]
    return { result: 'rapproche', clientId, message: `Tiers rapproché de la fiche ${how}.`, warnings }
  }
  return changed || contactsChanged
    ? { result: 'modifie', clientId, message: 'Fiche mise à jour.', warnings }
    : { result: 'inchange', clientId, message: 'Rien n’a changé.', warnings }
}

/** Remplace les contacts reçus du CRM pour ce tiers (`planContacts`). Vrai si quelque chose a changé. */
async function applyContacts(
  tx: Transaction,
  tenantId: string,
  connector: CrmConnectorId,
  clientId: string,
  received: ReceivedContact[],
  warnings: string[],
): Promise<boolean> {
  const receivedIds = received.map((contact) => contact.crmId)
  const rows = await tx
    .select({
      linkId: crmLinks.id,
      crmId: crmLinks.externalId,
      contactId: clientContacts.id,
      clientId: clientContacts.clientId,
      fullName: clientContacts.fullName,
      jobTitle: clientContacts.jobTitle,
      email: clientContacts.email,
      phone: clientContacts.phone,
      isBilling: clientContacts.isBilling,
      deletedAt: clientContacts.deletedAt,
      anonymizedAt: clientContacts.anonymizedAt,
    })
    .from(crmLinks)
    .innerJoin(clientContacts, and(eq(clientContacts.tenantId, crmLinks.tenantId), eq(clientContacts.id, crmLinks.localId)))
    .where(
      and(
        eq(crmLinks.tenantId, tenantId),
        eq(crmLinks.connector, connector),
        eq(crmLinks.entity, 'contact'),
        or(
          eq(clientContacts.clientId, clientId),
          receivedIds.length ? inArray(crmLinks.externalId, receivedIds) : undefined,
        ),
      ),
    )
    .for('update')

  // Un contact du CRM rattaché sur le site à une autre fiche : il n'est pas
  // déplacé en silence.
  const elsewhere = new Set(rows.filter((row) => row.clientId !== clientId).map((row) => row.crmId))
  for (const crmId of elsewhere) {
    warnings.push(`Le contact ${crmId} est rattaché à une autre fiche sur le site : non repris.`)
  }
  const mine = rows.filter((row) => row.clientId === clientId)
  const linkIds = new Map(mine.map((row) => [row.contactId, row.linkId]))
  const linked: LinkedContact[] = mine.map((row) => ({
    contactId: row.contactId,
    crmId: row.crmId,
    archived: row.deletedAt !== null,
    anonymized: row.anonymizedAt !== null,
    current: {
      fullName: row.fullName,
      jobTitle: row.jobTitle,
      email: row.email,
      phone: row.phone,
      isBilling: row.isBilling,
    },
  }))
  const plan = planContacts(
    received.filter((contact) => !elsewhere.has(contact.crmId)),
    linked,
  )

  for (const contact of plan.create) {
    const contactId = uuidv7()
    await tx.insert(clientContacts).values({ id: contactId, tenantId, clientId, ...contactFields(contact) })
    await tx.insert(crmLinks).values({ tenantId, connector, entity: 'contact', localId: contactId, externalId: contact.crmId })
  }
  for (const { contactId, contact, revive } of plan.update) {
    await tx
      .update(clientContacts)
      .set({ ...contactFields(contact), ...(revive ? { deletedAt: null } : {}) })
      .where(and(eq(clientContacts.tenantId, tenantId), eq(clientContacts.id, contactId)))
    await tx
      .update(crmLinks)
      .set({ removedAt: null, receivedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.id, linkIds.get(contactId)!)))
  }
  if (plan.remove.length > 0) {
    await tx
      .update(clientContacts)
      .set({ deletedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(and(eq(clientContacts.tenantId, tenantId), inArray(clientContacts.id, plan.remove)))
    await tx
      .update(crmLinks)
      .set({ removedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(
        and(
          eq(crmLinks.tenantId, tenantId),
          inArray(
            crmLinks.id,
            plan.remove.map((id) => linkIds.get(id)!),
          ),
        ),
      )
  }
  return plan.create.length + plan.update.length + plan.remove.length > 0
}

const contactFields = (contact: ReceivedContact) => ({
  fullName: contact.fullName,
  jobTitle: contact.jobTitle,
  email: contact.email,
  phone: contact.phone,
  isBilling: contact.isBilling,
})

/* ------------------------------------------------------------------------ */
/* Ce que le CRM lit                                                        */
/* ------------------------------------------------------------------------ */

export type ThirdPartyForCrm = {
  clientId: string
  dolibarrId: string | null
  reference: string | null
  recuLe: string | null
  nom: string
  statut: string
  siret: string | null
  numeroTva: string | null
  email: string | null
  telephone: string | null
  adresse: { ligne1: string | null; ligne2: string | null; codePostal: string | null; ville: string | null; pays: string }
}

/**
 * Les fiches vivantes du centre et le tiers du CRM de chacune
 * (`GET /api/dolibarr/tiers`) : pour rapprocher, une fois, les fiches que le
 * site avait avant le CRM. Par identifiant croissant, `apres` pour la page
 * suivante.
 */
export async function listThirdPartiesForCrm(
  connector: CrmConnectorId,
  filter: { linked?: boolean; limit: number; after?: string },
): Promise<ThirdPartyForCrm[]> {
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        ...fieldColumns,
        id: clients.id,
        crmId: crmLinks.externalId,
        crmRef: crmLinks.externalRef,
        receivedAt: crmLinks.receivedAt,
      })
      .from(clients)
      .leftJoin(
        crmLinks,
        and(
          eq(crmLinks.tenantId, clients.tenantId),
          eq(crmLinks.connector, connector),
          eq(crmLinks.entity, 'client'),
          eq(crmLinks.localId, clients.id),
          isNull(crmLinks.removedAt),
        ),
      )
      .where(
        and(
          eq(clients.tenantId, tenantId),
          isNull(clients.deletedAt),
          filter.linked === undefined ? undefined : filter.linked ? isNotNull(crmLinks.id) : isNull(crmLinks.id),
          filter.after ? gt(clients.id, filter.after) : undefined,
        ),
      )
      .orderBy(asc(clients.id))
      .limit(filter.limit),
  )
  return rows.map((row) => ({
    clientId: row.id,
    dolibarrId: row.crmId,
    reference: row.crmRef,
    recuLe: row.receivedAt?.toISOString() ?? null,
    nom: row.name,
    statut: thirdPartyStatusWords[row.status],
    siret: row.siret,
    numeroTva: row.vatNumber,
    email: row.email,
    telephone: row.phone,
    adresse: {
      ligne1: row.addressLine1,
      ligne2: row.addressLine2,
      codePostal: row.postalCode,
      ville: row.city,
      pays: row.country,
    },
  }))
}
