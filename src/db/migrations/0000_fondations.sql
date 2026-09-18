-- Fondations posées avant toute table métier : extensions, fabrique d'identifiants,
-- contexte de tenant, trigger de mise à jour.

-- Requis par la contrainte d'exclusion anti-double-réservation (migration 0002) :
-- permet de mélanger un index gist sur une plage temporelle et une égalité sur uuid.
CREATE EXTENSION IF NOT EXISTS btree_gist;

--> statement-breakpoint

-- UUID v7 : ordonné temporellement, donc bien plus compact en index qu'un v4.
-- Postgres 18 fournit uuidv7() nativement ; cette fonction disparaîtra à la
-- montée de version. Les 48 premiers bits d'un uuid v4 sont remplacés par
-- l'horodatage en millisecondes, puis le numéro de version est passé à 7.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

--> statement-breakpoint

-- Centre du contexte de session, positionné par l'application avec
-- `SET LOCAL app.tenant_id`. Renvoie NULL s'il n'est pas défini : les politiques
-- RLS (migration 0003) ne laissent alors passer aucune ligne. Défaut fermé.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

--> statement-breakpoint

-- Valeur par défaut de `tenant_id` sur les tables métier : le centre du contexte,
-- ou le centre unique tant que le produit est mono-centre. L'identifiant est
-- dupliqué dans src/db/tenants.ts (DEFAULT_TENANT_ID) et dans la migration 0002.
CREATE OR REPLACE FUNCTION tenant_id_default() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_tenant_id(), '01999f00-0000-7000-8000-000000000001'::uuid)
$$;

--> statement-breakpoint

-- `updated_at` tenu en base plutôt que dans le code : une mise à jour par SQL
-- direct ou par un futur script d'import reste datée correctement.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;
