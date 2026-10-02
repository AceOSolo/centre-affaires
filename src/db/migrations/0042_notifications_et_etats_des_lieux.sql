-- Vague 3 (ADR 038, 039) : ce que Drizzle ne sait pas décrire pour les
-- notifications et les états des lieux.
--
-- 1. Notifications : modèles réservés au back-office, journal des envois en
--    ajout seul sous portée client, préférences sous portée client, purge du
--    journal par une fonction SECURITY DEFINER (modèle de la migration 0024).
-- 2. États des lieux : modèles lisibles depuis l'espace client mais écrits
--    par le back-office seul, versions figées, états des lieux et photos sous
--    portée client (états clos seulement), garde des valeurs (CA011), état
--    clos figé (CA010), journal des consultations des photos, conservation et
--    purge des photos et du journal.
--
-- Mêmes règles que les migrations 0020, 0026 et 0031.

-- ---------------------------------------------------------------------------
-- 1. Notifications (R26, ADR 038)
-- ---------------------------------------------------------------------------
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_templates_tenant_isolation ON notification_templates
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Réglage du back-office : invisible depuis un espace client.
CREATE POLICY notification_templates_back_office_only ON notification_templates AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
-- Revenir au texte par défaut, c'est le réécrire : pas de suppression.
REVOKE DELETE, TRUNCATE ON notification_templates FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER notification_templates_set_updated_at
BEFORE UPDATE ON notification_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Journal des envois : on y ajoute, on y lit, rien d'autre — même double
-- verrou que le journal d'accès au courrier (migration 0020) : politiques en
-- lecture et en ajout seulement, droits retirés.
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_deliveries_tenant_read ON notification_deliveries
  FOR SELECT
  USING (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY notification_deliveries_tenant_append ON notification_deliveries
  FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Portée client : une entreprise ne lit que les messages qui lui ont été
-- adressés ; ceux envoyés au centre à son sujet restent au back-office.
CREATE POLICY notification_deliveries_client_scope ON notification_deliveries AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND audience = 'client')
  )
  WITH CHECK (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND audience = 'client')
  );
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON notification_deliveries FROM app_centre;

--> statement-breakpoint

-- Purge du journal au terme de `tenants.notification_log_retention_months`,
-- comptée depuis l'envoi. Seule porte d'effacement du journal : l'application
-- peut purger, jamais choisir quoi (modèle : migration 0024). Rend le nombre
-- de lignes effacées, pour le centre courant.
CREATE FUNCTION purge_expired_notification_deliveries() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH purged AS (
    DELETE FROM notification_deliveries AS d
    USING tenants
    WHERE tenants.id = current_tenant_id()
      AND d.tenant_id = tenants.id
      AND d.sent_at < now() - make_interval(months => tenants.notification_log_retention_months)
    RETURNING 1
  )
  SELECT count(*)::integer FROM purged
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_notification_deliveries() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_notification_deliveries() TO app_centre;

--> statement-breakpoint

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_preferences_tenant_isolation ON notification_preferences
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY notification_preferences_client_scope ON notification_preferences AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Une préférence se change (upsert), elle ne se supprime pas.
REVOKE DELETE, TRUNCATE ON notification_preferences FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER notification_preferences_set_updated_at
BEFORE UPDATE ON notification_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. États des lieux (R06, R33, ADR 039)
-- ---------------------------------------------------------------------------
-- Modèles et versions : sans client, donc lisibles depuis un espace client
-- (les libellés des champs s'y affichent), comme `resources`. Mais écrits par
-- le back-office seul : politiques restrictives sur l'écriture.
ALTER TABLE inspection_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inspection_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inspection_templates_tenant_isolation ON inspection_templates
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY inspection_templates_back_office_insert ON inspection_templates AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
CREATE POLICY inspection_templates_back_office_update ON inspection_templates AS RESTRICTIVE
  FOR UPDATE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON inspection_templates FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER inspection_templates_set_updated_at
BEFORE UPDATE ON inspection_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

ALTER TABLE inspection_template_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inspection_template_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inspection_template_versions_tenant_isolation ON inspection_template_versions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY inspection_template_versions_back_office_insert ON inspection_template_versions AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
-- Une version publiée est figée : c'est elle que gardent les états des lieux
-- saisis avec. Modifier un modèle, c'est en publier une nouvelle.
REVOKE UPDATE, DELETE, TRUNCATE ON inspection_template_versions FROM app_centre;

--> statement-breakpoint

ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inspections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inspections_tenant_isolation ON inspections
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Portée client : les états des lieux clos de ses entreprises, jamais un
-- brouillon (comme une facture, migration 0031).
CREATE POLICY inspections_client_scope ON inspections AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND status = 'closed' AND deleted_at IS NULL)
  )
  WITH CHECK (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND status = 'closed' AND deleted_at IS NULL)
  );
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON inspections FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER inspections_set_updated_at
BEFORE UPDATE ON inspections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Garde des états des lieux :
--
-- - un état des lieux naît brouillon, au centre (jamais sous portée client),
--   avec la version du modèle du **type** de sa ressource (CA011) ;
-- - ne changent jamais : nature, ressource, client, version du modèle,
--   auteur (CA010) ;
-- - brouillon : les valeurs suivent la version (clés connues, types,
--   options, échelle) ; à la clôture (`status` → `closed`, `closed_by`
--   exigé, `closed_at` posé par la base), chaque champ obligatoire est
--   renseigné (CA011) ; une sortie désigne une entrée close de la même
--   ressource et du même client ;
-- - clos : figé (CA010), sauf la validation du client, une fois —
--   `signed_by_member_id` et `client_remarks`, `signed_at` posé par la base.
--
-- `app.anonymization` laisse passer l'anonymisation (ADR 040).
CREATE FUNCTION inspections_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fields jsonb;
  v_template_type resource_type;
  v_resource_type resource_type;
  v_entry inspections%ROWTYPE;
  v_error text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un état des lieux ne se supprime pas : un brouillon se retire (deleted_at), un état clos reste.'
      USING ERRCODE = 'CA010';
  END IF;
  IF coalesce(current_setting('app.anonymization', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_client_ids() IS NOT NULL THEN
      RAISE EXCEPTION 'Un état des lieux se saisit au centre, pas depuis l''espace client.'
        USING ERRCODE = 'CA010';
    END IF;
    IF NEW.status <> 'draft'
       OR num_nonnulls(NEW.closed_at, NEW.closed_by, NEW.signed_at, NEW.signed_by_member_id,
                       NEW.client_remarks, NEW.deleted_at) > 0 THEN
      RAISE EXCEPTION 'Un état des lieux naît brouillon : il se clôt, puis le client le valide.'
        USING ERRCODE = 'CA011';
    END IF;
  ELSE
    IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.resource_id, NEW.client_id, NEW.template_version_id,
        NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.kind, OLD.resource_id, OLD.client_id, OLD.template_version_id,
        OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Un état des lieux ne change ni de nature, ni de ressource, ni de client, ni de version de modèle.'
        USING ERRCODE = 'CA010';
    END IF;

    IF OLD.status = 'closed' THEN
      IF to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at' THEN
        RETURN NEW;
      END IF;
      IF OLD.signed_at IS NULL AND NEW.signed_by_member_id IS NOT NULL
         AND to_jsonb(NEW) - '{signed_at,signed_by_member_id,client_remarks,updated_at}'::text[]
             = to_jsonb(OLD) - '{signed_at,signed_by_member_id,client_remarks,updated_at}'::text[] THEN
        NEW.signed_at := now();
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Cet état des lieux est clos : il ne change plus%.',
        CASE WHEN OLD.signed_at IS NULL THEN ' ; seule la validation du client reste à venir' ELSE '' END
        USING ERRCODE = 'CA010';
    END IF;

    -- Brouillon.
    IF current_client_ids() IS NOT NULL THEN
      RAISE EXCEPTION 'Un état des lieux en saisie ne se modifie pas depuis l''espace client.'
        USING ERRCODE = 'CA010';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ce brouillon d''état des lieux a été retiré.' USING ERRCODE = 'CA010';
    END IF;
    IF num_nonnulls(NEW.signed_at, NEW.signed_by_member_id, NEW.client_remarks) > 0 THEN
      RAISE EXCEPTION 'Le client valide un état des lieux clos, pas un brouillon.' USING ERRCODE = 'CA011';
    END IF;
  END IF;

  SELECT v.fields, t.resource_type INTO v_fields, v_template_type
    FROM inspection_template_versions AS v
    JOIN inspection_templates AS t ON t.tenant_id = v.tenant_id AND t.id = v.template_id
   WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.template_version_id;
  IF NOT FOUND THEN
    -- La clé étrangère le dira, avec son propre code.
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT resource_type INTO v_resource_type FROM resources
     WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;
    IF FOUND AND v_resource_type IS DISTINCT FROM v_template_type THEN
      RAISE EXCEPTION 'Ce modèle d''état des lieux est celui du type « % » : la ressource est du type « % ».',
        v_template_type, v_resource_type
        USING ERRCODE = 'CA011';
    END IF;
  END IF;

  IF NEW.entry_inspection_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.entry_inspection_id IS DISTINCT FROM OLD.entry_inspection_id) THEN
    SELECT * INTO v_entry FROM inspections
     WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_inspection_id;
    IF FOUND AND (v_entry.kind <> 'entry' OR v_entry.status <> 'closed' OR v_entry.deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Une sortie désigne l''état des lieux d''entrée qu''elle clôt, et celui-ci doit être clos.'
        USING ERRCODE = 'CA011';
    END IF;
  END IF;

  v_error := inspection_values_error(v_fields, NEW.values, NEW.status = 'closed');
  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION '%', v_error USING ERRCODE = 'CA011';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'closed' THEN
    IF NEW.closed_by IS NULL THEN
      RAISE EXCEPTION 'La clôture d''un état des lieux porte son auteur.' USING ERRCODE = 'CA011';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un brouillon retiré ne se clôt pas.' USING ERRCODE = 'CA011';
    END IF;
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inspections_guard
BEFORE INSERT OR UPDATE OR DELETE ON inspections
FOR EACH ROW EXECUTE FUNCTION inspections_guard();

--> statement-breakpoint

ALTER TABLE inspection_photos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inspection_photos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inspection_photos_tenant_isolation ON inspection_photos
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Les photos suivent leur état des lieux ; la sous-requête est elle-même
-- soumise aux politiques de `inspections` (états clos de la portée).
CREATE POLICY inspection_photos_client_scope ON inspection_photos AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM inspections AS i
       WHERE i.tenant_id = inspection_photos.tenant_id
         AND i.id = inspection_photos.inspection_id
         AND i.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM inspections AS i
       WHERE i.tenant_id = inspection_photos.tenant_id
         AND i.id = inspection_photos.inspection_id
         AND i.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON inspection_photos FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER inspection_photos_set_updated_at
BEFORE UPDATE ON inspection_photos
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Garde des photos : déposées, légendées, rattachées à un champ ou retirées
-- tant que l'état des lieux est un brouillon, au centre (CA010) ; le fichier
-- et l'état des lieux d'une photo ne changent jamais ; le champ illustré est
-- un champ de la version du modèle (CA011). L'état des lieux est verrouillé
-- en partage : une photo ne se glisse pas pendant sa clôture.
--
-- `app.inspection_photo_purge` laisse passer la purge, et elle seule
-- (`mark_inspection_photo_purged`).
CREATE FUNCTION inspection_photos_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inspection inspections%ROWTYPE;
  v_fields jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une photo d''état des lieux ne se supprime pas : elle se retire d''un brouillon (deleted_at).'
      USING ERRCODE = 'CA010';
  END IF;
  IF coalesce(current_setting('app.inspection_photo_purge', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'Les photos d''un état des lieux se déposent au centre.' USING ERRCODE = 'CA010';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.tenant_id, NEW.inspection_id, NEW.storage_key, NEW.encryption_key_version,
        NEW.content_type, NEW.byte_size, NEW.width, NEW.height, NEW.uploaded_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.inspection_id, OLD.storage_key, OLD.encryption_key_version,
        OLD.content_type, OLD.byte_size, OLD.width, OLD.height, OLD.uploaded_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Une photo déposée ne change ni de fichier ni d''état des lieux : retirez-la et déposez-en une autre.'
        USING ERRCODE = 'CA010';
    END IF;
    IF to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at' THEN
      RETURN NEW;
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cette photo a été retirée.' USING ERRCODE = 'CA010';
    END IF;
  END IF;

  SELECT * INTO v_inspection FROM inspections
   WHERE tenant_id = NEW.tenant_id AND id = NEW.inspection_id
   FOR SHARE;
  IF NOT FOUND THEN
    -- La clé étrangère le dira, avec son propre code.
    RETURN NEW;
  END IF;
  IF v_inspection.status <> 'draft' OR v_inspection.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cet état des lieux est clos ou retiré : ses photos ne changent plus.'
      USING ERRCODE = 'CA010';
  END IF;

  IF NEW.field_id IS NOT NULL THEN
    SELECT fields INTO v_fields FROM inspection_template_versions
     WHERE tenant_id = NEW.tenant_id AND id = v_inspection.template_version_id;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_fields) AS f WHERE f ->> 'id' = NEW.field_id
    ) THEN
      RAISE EXCEPTION 'Le champ « % » n''existe pas dans le modèle de cet état des lieux.', NEW.field_id
        USING ERRCODE = 'CA011';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_photos_guard
BEFORE INSERT OR UPDATE OR DELETE ON inspection_photos
FOR EACH ROW EXECUTE FUNCTION inspection_photos_guard();

--> statement-breakpoint

-- Journal des consultations des photos : comme `mail_scan_views` (0020).
ALTER TABLE inspection_photo_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inspection_photo_views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inspection_photo_views_tenant_read ON inspection_photo_views
  FOR SELECT
  USING (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY inspection_photo_views_tenant_append ON inspection_photo_views
  FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY inspection_photo_views_client_scope ON inspection_photo_views AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM inspection_photos AS p
        JOIN inspections AS i ON i.tenant_id = p.tenant_id AND i.id = p.inspection_id
       WHERE p.tenant_id = inspection_photo_views.tenant_id
         AND p.id = inspection_photo_views.photo_id
         AND i.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM inspection_photos AS p
        JOIN inspections AS i ON i.tenant_id = p.tenant_id AND i.id = p.inspection_id
       WHERE p.tenant_id = inspection_photo_views.tenant_id
         AND p.id = inspection_photo_views.photo_id
         AND i.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON inspection_photo_views FROM app_centre;

--> statement-breakpoint

-- Départ de la conservation des photos d'un état des lieux (ADR 039) : la
-- clôture de la sortie. Pour une sortie, la sienne ; pour une entrée, celle
-- de la sortie close qui la désigne. NULL — rien ne court — pour un
-- brouillon, ou pour une entrée sans sortie close : l'occupation dure, ou la
-- sortie reste à faire, et l'entrée en est la preuve.
CREATE FUNCTION inspection_photo_retention_start(i inspections) RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN i.status <> 'closed' THEN NULL
    WHEN i.kind = 'exit' THEN i.closed_at
    ELSE (
      SELECT min(x.closed_at) FROM inspections AS x
       WHERE x.tenant_id = i.tenant_id AND x.entry_inspection_id = i.id
         AND x.status = 'closed' AND x.deleted_at IS NULL
    )
  END
$$;

--> statement-breakpoint

-- Photos échues du centre courant, à purger : d'abord le fichier du stockage
-- (le code), puis la ligne (`mark_inspection_photo_purged`). Par lots, de la
-- plus ancienne à la plus récente. Sous les politiques de l'appelant.
CREATE FUNCTION expired_inspection_photos(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, storage_key text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.storage_key
    FROM inspection_photos AS p
    JOIN inspections AS i ON i.tenant_id = p.tenant_id AND i.id = p.inspection_id
    JOIN tenants AS t ON t.id = p.tenant_id
   WHERE p.tenant_id = current_tenant_id()
     AND p.deleted_at IS NULL
     AND inspection_photo_retention_start(i)
         < now() - make_interval(months => t.inspection_photo_retention_months)
   ORDER BY p.created_at, p.id
   LIMIT p_limit
$$;

--> statement-breakpoint

-- Marque une photo purgée, une fois son fichier effacé du stockage. Revérifie
-- l'échéance : l'application peut purger, jamais choisir quoi. Rend vrai si
-- la photo était échue et vient d'être marquée. Seul chemin pour retirer une
-- photo d'un état des lieux clos.
CREATE FUNCTION mark_inspection_photo_purged(p_photo_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.inspection_photo_purge', true), '');
  v_done boolean;
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'La purge des photos est une tâche du back-office.' USING ERRCODE = 'CA010';
  END IF;
  PERFORM set_config('app.inspection_photo_purge', 'on', true);
  UPDATE inspection_photos AS p
     SET deleted_at = now()
    FROM inspections AS i, tenants AS t
   WHERE p.id = p_photo_id
     AND p.tenant_id = current_tenant_id()
     AND p.deleted_at IS NULL
     AND i.tenant_id = p.tenant_id AND i.id = p.inspection_id
     AND t.id = p.tenant_id
     AND inspection_photo_retention_start(i)
         < now() - make_interval(months => t.inspection_photo_retention_months);
  v_done := FOUND;
  PERFORM set_config('app.inspection_photo_purge', v_previous, true);
  RETURN v_done;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mark_inspection_photo_purged(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mark_inspection_photo_purged(uuid) TO app_centre;

--> statement-breakpoint

-- Purge du journal des consultations des photos, au terme de
-- `tenants.inspection_access_log_retention_months` (modèle : 0024).
CREATE FUNCTION purge_expired_inspection_photo_views() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH purged AS (
    DELETE FROM inspection_photo_views AS views
    USING tenants
    WHERE tenants.id = current_tenant_id()
      AND views.tenant_id = tenants.id
      AND views.viewed_at < now() - make_interval(months => tenants.inspection_access_log_retention_months)
    RETURNING 1
  )
  SELECT count(*)::integer FROM purged
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_inspection_photo_views() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_inspection_photo_views() TO app_centre;
