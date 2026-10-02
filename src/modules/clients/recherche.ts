import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientContacts, clients, type Client, type ClientStatus } from './schema.ts'

/**
 * Recherche dans la liste des clients (R07) : par raison sociale, SIRET, nom
 * d'un contact ou ville.
 */

/** Motifs `ilike` tirés de la saisie, ou `null` quand il n'y a rien à chercher. */
export type ClientSearchTerms = {
  /** « %acme% », caractères spéciaux de `like` neutralisés. */
  pattern: string
  /**
   * Motif sur le SIRET, chiffres seuls : « 123 456 789 » trouve
   * « 12345678900012 », rangé sans espaces. `null` si la saisie n'est pas
   * faite que de chiffres et de séparateurs.
   */
  siretPattern: string | null
}

/** Au-delà, ce n'est plus une recherche : la saisie est tronquée. */
const MAX_SEARCH_LENGTH = 100

/**
 * Neutralise `%`, `_` et la barre oblique inverse, jokers de `like` : chercher
 * « 100% » ne doit pas trouver tous les clients dont le nom contient « 100 ».
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export function clientSearchTerms(raw: string | null | undefined): ClientSearchTerms | null {
  const query = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_SEARCH_LENGTH).trim()
  if (!query) return null
  const digits = query.replace(/[\s.]/g, '')
  return {
    pattern: `%${escapeLike(query)}%`,
    siretPattern: /^\d+$/.test(digits) ? `%${digits}%` : null,
  }
}

/**
 * Condition de recherche sur `clients`. Un contact retiré ne fait plus
 * trouver la fiche : il n'y figure plus.
 */
export function clientSearchCondition(terms: ClientSearchTerms): SQL {
  return or(
    sql`${clients.name} ilike ${terms.pattern}`,
    sql`${clients.city} ilike ${terms.pattern}`,
    terms.siretPattern ? sql`${clients.siret} like ${terms.siretPattern}` : undefined,
    sql`exists (
      select 1 from ${clientContacts}
      where ${clientContacts.tenantId} = ${clients.tenantId}
        and ${clientContacts.clientId} = ${clients.id}
        and ${clientContacts.deletedAt} is null
        and ${clientContacts.fullName} ilike ${terms.pattern})`,
  ) as SQL
}

/** Une ligne de la liste des clients. */
export type ClientDirectoryRow = Client & {
  /** Contact principal actif, quand la fiche en a un. */
  primaryContact: { fullName: string; jobTitle: string | null; email: string | null; phone: string | null } | null
  /**
   * Contacts dont le nom correspond à la recherche, séparés par des virgules :
   * dit pourquoi une fiche est remontée quand son nom ne contient pas la saisie.
   */
  matchedContactNames: string | null
}

/** Clients vivants du centre, filtrés par statut et par recherche, par raison sociale. */
export async function searchClients(
  filters: { status?: ClientStatus; search?: string } = {},
): Promise<ClientDirectoryRow[]> {
  const terms = clientSearchTerms(filters.search)
  const primary = alias(clientContacts, 'primary_contact')

  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        client: clients,
        primaryContact: {
          fullName: primary.fullName,
          jobTitle: primary.jobTitle,
          email: primary.email,
          phone: primary.phone,
        },
        matchedContactNames: terms
          ? sql<string | null>`(
              select string_agg(${clientContacts.fullName}, ', ' order by ${clientContacts.fullName})
              from ${clientContacts}
              where ${clientContacts.tenantId} = ${clients.tenantId}
                and ${clientContacts.clientId} = ${clients.id}
                and ${clientContacts.deletedAt} is null
                and ${clientContacts.fullName} ilike ${terms.pattern})`
          : sql<null>`null`,
      })
      .from(clients)
      // Au plus un principal actif par fiche (`client_contacts_primary_key`) :
      // la jointure ne duplique aucune ligne.
      .leftJoin(
        primary,
        and(
          eq(primary.tenantId, clients.tenantId),
          eq(primary.clientId, clients.id),
          eq(primary.isPrimary, true),
          isNull(primary.deletedAt),
        ),
      )
      .where(
        and(
          isNull(clients.deletedAt),
          filters.status ? eq(clients.status, filters.status) : undefined,
          terms ? clientSearchCondition(terms) : undefined,
        ),
      )
      .orderBy(asc(clients.name), asc(clients.id)),
  )

  return rows.map(({ client, primaryContact, matchedContactNames }) => ({
    ...client,
    primaryContact,
    matchedContactNames,
  }))
}
