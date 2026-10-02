-- Purge du journal d'accès aux numérisations au terme de sa durée de
-- conservation (RGPD, ADR 015).
--
-- La migration 0020 retire à `app_centre` tout droit de modifier ou d'effacer
-- `mail_scan_views` : un journal que l'application peut réécrire ne prouve
-- rien. Mais une donnée personnelle ne se garde pas indéfiniment. Cette
-- fonction est la seule porte d'effacement, et elle ne s'ouvre que sur ce qui
-- a dépassé la durée fixée par le centre : l'application peut purger, jamais
-- choisir quoi.
--
-- SECURITY DEFINER : elle s'exécute avec les droits du propriétaire, qui
-- contourne la RLS. Le filtre sur `current_tenant_id()` est donc écrit ici
-- explicitement, et `search_path` est figé pour qu'aucun objet homonyme ne
-- s'y substitue.

CREATE FUNCTION purge_expired_mail_scan_views() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH purged AS (
    DELETE FROM mail_scan_views AS views
    USING tenants
    WHERE tenants.id = current_tenant_id()
      AND views.tenant_id = tenants.id
      AND views.viewed_at < now() - make_interval(months => tenants.mail_access_log_retention_months)
    RETURNING 1
  )
  SELECT count(*)::integer FROM purged
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION purge_expired_mail_scan_views() FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION purge_expired_mail_scan_views() TO app_centre;
