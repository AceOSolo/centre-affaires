-- Vague 1 du cahier des charges (ADR 018 à 021) : ce que Drizzle ne sait pas
-- décrire. Reprise du canal des réservations, occupation des ressources sous
-- contrat, isolation des clients entre eux, numérotation des documents,
-- anonymisation des demandes publiques.
--
-- Mêmes règles que les migrations 0003, 0020 et 0024 : toute table métier en
-- ENABLE et FORCE ROW LEVEL SECURITY, les fonctions SECURITY DEFINER filtrent
-- elles-mêmes sur `current_tenant_id()` et figent leur `search_path`.

-- ---------------------------------------------------------------------------
-- 1. Canal des réservations existantes (R05, ADR 018)
-- ---------------------------------------------------------------------------
-- Déduit des colonnes que chaque chemin d'écriture remplissait :
-- - des coordonnées de demandeur : la page publique (ADR 005) ; rattachée à une
--   entreprise dès le dépôt, c'était une personne connectée à son espace
--   (ADR 015) ;
-- - sinon : l'équipe, seule à pouvoir écrire ailleurs.
-- Une demande publique rattachée plus tard à un client par l'équipe est donc
-- comptée `client` : le schéma ne distinguait pas les deux cas.
--
-- `updated_at` n'est pas touché : la reprise n'est pas une modification de la
-- réservation.
ALTER TABLE bookings DISABLE TRIGGER bookings_set_updated_at;
--> statement-breakpoint
UPDATE bookings
   SET channel = CASE
     WHEN requester_name IS NULL AND requester_email IS NULL AND requester_phone IS NULL
       THEN 'staff'
     WHEN client_id IS NOT NULL THEN 'client'
     ELSE 'public'
   END::booking_channel
 WHERE channel IS NULL;
--> statement-breakpoint
ALTER TABLE bookings ENABLE TRIGGER bookings_set_updated_at;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Occupation des ressources sous contrat (R02, R04, D6, ADR 018)
-- ---------------------------------------------------------------------------
-- Un contrat qui loue une ressource la fait occuper par une ligne de `bookings`
-- (`kind = 'contract'`, `contract_id` posé), tenue à jour par un trigger sur
-- `contracts`. La contrainte `bookings_no_overlap` (décision 3) protège alors
-- tout : deux contrats sur le même bureau, une réservation horaire pendant un
-- contrat, un contrat activé sur un créneau déjà réservé. Les calendriers lisent
-- `bookings` comme avant et voient l'occupation sans rien unir.

-- Fin d'une occupation sans terme. Pas `infinity` : le pilote Node lit les
-- `timestamptz` en `Date`, et `infinity` y deviendrait une `Invalid Date`.
-- Même valeur que OPEN_ENDED_BOOKING_END (src/modules/reservations/schema.ts).
CREATE FUNCTION booking_open_end() RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT timestamptz '9999-12-31 00:00:00+00'
$$;

--> statement-breakpoint

-- Aligne l'occupation d'un contrat sur le contrat. Idempotente : ne réécrit la
-- ligne que si elle diffère.
--
-- Occupé : contrat non archivé, `active` ou `terminated`, avec une ressource,
-- et dont le dernier jour n'est pas antérieur au premier. Un contrat résilié
-- garde son occupation jusqu'à sa date de résiliation : la ressource redevient
-- libre le lendemain, l'historique reste.
--
-- Les dates du contrat sont des jours civils du centre, bornes comprises
-- (ADR 006) : l'occupation va de minuit, heure du centre, au premier jour à
-- minuit le lendemain du dernier jour — bornes `[)` comme toute réservation.
--
-- Pose `app.contract_occupation_sync` le temps de l'écriture : c'est ce que
-- regarde le garde de `bookings` (plus bas) pour laisser passer.
CREATE FUNCTION apply_contract_occupation(c contracts) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  last_day date := least(c.ends_on, c.terminated_on);
  occupation bookings%ROWTYPE;
  has_occupation boolean;
  occupied boolean;
  centre_time_zone text;
  range_start timestamptz;
  range_end timestamptz;
  occupation_title text := 'Contrat ' || c.reference;
BEGIN
  SELECT * INTO occupation
    FROM bookings
   WHERE tenant_id = c.tenant_id AND contract_id = c.id AND kind = 'contract'
   FOR UPDATE;
  has_occupation := FOUND;

  occupied := c.deleted_at IS NULL
          AND c.status IN ('active', 'terminated')
          AND c.resource_id IS NOT NULL
          AND (last_day IS NULL OR last_day >= c.starts_on);

  PERFORM set_config('app.contract_occupation_sync', 'on', true);

  IF NOT occupied THEN
    IF has_occupation AND occupation.status <> 'cancelled' THEN
      UPDATE bookings
         SET status = 'cancelled',
             cancelled_at = now(),
             cancellation_reason = CASE
               WHEN c.deleted_at IS NOT NULL THEN 'Contrat archivé'
               WHEN c.status = 'draft' THEN 'Contrat repassé en brouillon'
               WHEN c.resource_id IS NULL THEN 'Ressource retirée du contrat'
               ELSE 'Contrat résilié avant son début'
             END
       WHERE id = occupation.id;
    END IF;
  ELSE
    SELECT t.timezone INTO centre_time_zone FROM tenants AS t WHERE t.id = c.tenant_id;
    IF centre_time_zone IS NULL THEN
      RAISE EXCEPTION 'Fuseau du centre % introuvable : impossible de dater l''occupation du contrat %.',
        c.tenant_id, c.reference;
    END IF;

    range_start := c.starts_on::timestamp AT TIME ZONE centre_time_zone;
    range_end := CASE
      WHEN last_day IS NULL THEN booking_open_end()
      ELSE (last_day + 1)::timestamp AT TIME ZONE centre_time_zone
    END;

    IF NOT has_occupation THEN
      INSERT INTO bookings (
        tenant_id, resource_id, contract_id, client_id, kind, channel, status, title,
        starts_at, ends_at
      )
      VALUES (
        c.tenant_id, c.resource_id, c.id, c.client_id, 'contract', 'staff', 'confirmed',
        occupation_title, range_start, range_end
      );
    ELSIF occupation.status <> 'confirmed'
       OR occupation.resource_id <> c.resource_id
       OR occupation.starts_at <> range_start
       OR occupation.ends_at <> range_end
       OR occupation.client_id IS DISTINCT FROM c.client_id
       OR occupation.title <> occupation_title THEN
      UPDATE bookings
         SET resource_id = c.resource_id,
             client_id = c.client_id,
             title = occupation_title,
             starts_at = range_start,
             ends_at = range_end,
             status = 'confirmed',
             cancelled_at = NULL,
             cancellation_reason = NULL
       WHERE id = occupation.id;
    END IF;
  END IF;

  PERFORM set_config('app.contract_occupation_sync', '', true);
END
$$;

--> statement-breakpoint

CREATE FUNCTION contracts_sync_occupation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM apply_contract_occupation(NEW);
  RETURN NULL;
END
$$;

--> statement-breakpoint

-- Après l'écriture du contrat : un chevauchement fait échouer l'activation, la
-- résiliation ou le changement de ressource lui-même (SQLSTATE 23P01), jamais
-- une écriture à moitié faite.
CREATE TRIGGER contracts_sync_occupation
AFTER INSERT OR UPDATE ON contracts
FOR EACH ROW EXECUTE FUNCTION contracts_sync_occupation();

--> statement-breakpoint

-- Une occupation ne s'écrit qu'à travers son contrat. Sans ce garde, annuler la
-- ligne depuis le planning libérerait un bureau toujours loué, et un second
-- contrat pourrait s'y activer. Refus explicite (SQLSTATE CA001) plutôt qu'une
-- mise à jour qui ne toucherait rien.
--
-- Garde contre les erreurs de l'application, pas frontière de sécurité : le
-- rôle applicatif écrit dans `contracts`, donc décide déjà de l'occupation.
CREATE FUNCTION bookings_guard_contract_occupation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  locked boolean := false;
BEGIN
  IF coalesce(current_setting('app.contract_occupation_sync', true), '') <> 'on' THEN
    IF TG_OP <> 'INSERT' THEN
      locked := OLD.kind = 'contract';
    END IF;
    IF TG_OP <> 'DELETE' AND NOT locked THEN
      locked := NEW.kind = 'contract';
    END IF;
  END IF;

  IF locked THEN
    RAISE EXCEPTION 'Cette occupation est tenue par son contrat : elle ne se modifie qu''à travers lui.'
      USING ERRCODE = 'CA001',
            HINT = 'Activer, résilier ou archiver le contrat, ou en changer la ressource ou les dates, met l''occupation à jour.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

CREATE TRIGGER bookings_guard_contract_occupation
BEFORE INSERT OR UPDATE OR DELETE ON bookings
FOR EACH ROW EXECUTE FUNCTION bookings_guard_contract_occupation();

--> statement-breakpoint

-- Pose l'occupation de tous les contrats qui en appellent une. Un contrat dont
-- la ressource est déjà occupée sur sa période (deux contrats actifs sur le
-- même bureau, une réservation horaire pendant le contrat) est signalé par un
-- NOTICE et laissé sans occupation, au lieu de faire échouer la migration en
-- production : les données contradictoires existaient avant elle, c'est à
-- l'équipe de trancher. Les plus anciens contrats passent d'abord.
--
-- Rejouable par le propriétaire une fois le conflit résolu :
--   SELECT backfill_contract_occupations();
-- Rend le nombre de contrats laissés sans occupation.
CREATE FUNCTION backfill_contract_occupations() RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c contracts%ROWTYPE;
  skipped integer := 0;
BEGIN
  FOR c IN
    SELECT * FROM contracts
     WHERE deleted_at IS NULL
       AND status IN ('active', 'terminated')
       AND resource_id IS NOT NULL
     ORDER BY starts_on, created_at, id
  LOOP
    BEGIN
      PERFORM apply_contract_occupation(c);
    EXCEPTION WHEN exclusion_violation THEN
      skipped := skipped + 1;
      RAISE NOTICE 'Contrat % (%) : la ressource % est déjà occupée sur sa période, occupation non posée (%).',
        c.reference, c.id, c.resource_id, SQLERRM;
    END;
  END LOOP;
  RETURN skipped;
END
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION backfill_contract_occupations() FROM PUBLIC;

--> statement-breakpoint

DO $$
DECLARE
  skipped integer;
BEGIN
  skipped := backfill_contract_occupations();
  IF skipped > 0 THEN
    RAISE NOTICE '% contrat(s) sans occupation, à résoudre à la main (ADR 018) puis : SELECT backfill_contract_occupations();',
      skipped;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Contacts des clients (R07)
-- ---------------------------------------------------------------------------
ALTER TABLE client_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE client_contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY client_contacts_tenant_isolation ON client_contacts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER client_contacts_set_updated_at
BEFORE UPDATE ON client_contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Numérotation des documents (R12, ADR 021)
-- ---------------------------------------------------------------------------
-- Les compteurs ne bougent que par `next_document_number()`. Le rôle
-- applicatif les lit, il ne les écrit pas : retirer le droit fait échouer
-- bruyamment une tentative, comme pour le journal d'accès (migration 0020).
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_sequences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY document_sequences_tenant_isolation ON document_sequences
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_sequences FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER document_sequences_set_updated_at
BEFORE UPDATE ON document_sequences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Numéro suivant d'un type de document pour le centre du contexte :
-- `CT-2026-0001` (contrat), `FA-2026-0001` (facture), `AV-2026-0001` (avoir).
--
-- Une série par centre, par type et par année civile du centre ; l'année est
-- dans le numéro (ADR 021). Quatre chiffres au moins, davantage au-delà de 9999
-- — jamais tronqué.
--
-- Sans trou ni doublon, même en concurrence : l'`ON CONFLICT DO UPDATE` prend
-- le verrou de la ligne du compteur jusqu'à la fin de la transaction appelante.
-- Une seconde transaction attend, puis lit la valeur validée. Une transaction
-- annulée rend son numéro, contrairement à une SEQUENCE Postgres qui le
-- perdrait. Le prix : les numérotations d'un même type se font l'une après
-- l'autre dans un centre, ce qui est sans effet à ce volume.
CREATE FUNCTION next_document_number(p_type document_type) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := current_tenant_id();
  v_time_zone text;
  v_year integer;
  v_value integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Numérotation impossible hors du contexte d''un centre (app.tenant_id).';
  END IF;

  SELECT timezone INTO v_time_zone FROM tenants WHERE id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Centre % inconnu : numérotation impossible.', v_tenant;
  END IF;
  v_year := extract(year FROM now() AT TIME ZONE v_time_zone)::integer;

  INSERT INTO document_sequences AS s (tenant_id, document_type, year, last_value)
  VALUES (v_tenant, p_type, v_year, 1)
  ON CONFLICT (tenant_id, document_type, year)
  DO UPDATE SET last_value = s.last_value + 1
  RETURNING s.last_value INTO v_value;

  RETURN CASE p_type
           WHEN 'contract' THEN 'CT'
           WHEN 'invoice' THEN 'FA'
           WHEN 'credit_note' THEN 'AV'
         END
         || '-' || v_year::text
         || '-' || lpad(v_value::text, greatest(4, length(v_value::text)), '0');
END
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION next_document_number(document_type) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION next_document_number(document_type) TO app_centre;

--> statement-breakpoint

-- Référence d'un contrat saisi sans référence : valeur par défaut de
-- `contracts.reference` (migration 0027). Passe les numéros déjà portés par un
-- contrat saisi à la main, archivé compris : sans cela, une référence manuelle
-- égale au numéro suivant bloquerait la numérotation automatique pour toujours.
-- Un numéro sauté de cette façon n'est pas un trou : il est porté par ce
-- contrat. SECURITY DEFINER pour voir tous les contrats du centre, quelle que
-- soit la portée client de la transaction.
CREATE FUNCTION next_contract_reference() RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reference text;
BEGIN
  LOOP
    v_reference := next_document_number('contract');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM contracts
       WHERE tenant_id = current_tenant_id() AND reference = v_reference
    );
  END LOOP;
  RETURN v_reference;
END
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION next_contract_reference() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION next_contract_reference() TO app_centre;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Isolation des clients entre eux (R28, ADR 019)
-- ---------------------------------------------------------------------------
-- Second niveau, sous l'isolation par centre. Une transaction qui porte une
-- portée client (`app.client_ids`, posé par `withClientScope()` dans
-- src/db/index.ts) ne voit, et n'écrit, que les lignes de ces entreprises.
-- Sans portée — le back-office — rien ne change.
--
-- Politiques RESTRICTIVE : elles s'ajoutent en ET aux politiques par centre au
-- lieu de s'y substituer en OU. Une portée vide (`{}`) ne laisse rien passer :
-- défaut fermé, comme `app.tenant_id`.
--
-- Comme pour `app.tenant_id`, c'est un garde contre l'oubli d'un filtre dans
-- le code de l'espace client, pas contre un code qui choisirait sa portée.

-- Entreprises de la portée, ou NULL hors portée client.
CREATE FUNCTION current_client_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.client_ids', true), '')::uuid[]
$$;

--> statement-breakpoint

CREATE POLICY clients_client_scope ON clients AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR id = ANY (current_client_ids()));
--> statement-breakpoint
CREATE POLICY client_members_client_scope ON client_members AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
CREATE POLICY client_contacts_client_scope ON client_contacts AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
CREATE POLICY contracts_client_scope ON contracts AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Une réservation sans client (indisponibilité, réservation interne, demande
-- d'un visiteur) n'appartient à aucune portée : invisible depuis un espace
-- client. Les créneaux occupés se lisent par `booking_busy_ranges()`.
CREATE POLICY bookings_client_scope ON bookings AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
CREATE POLICY mail_items_client_scope ON mail_items AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Les numérisations et leur journal n'ont pas de `client_id` : ils suivent le
-- pli. La sous-requête est elle-même soumise aux politiques de `mail_items`.
CREATE POLICY mail_scans_client_scope ON mail_scans AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM mail_items AS item
       WHERE item.tenant_id = mail_scans.tenant_id
         AND item.id = mail_scans.mail_item_id
         AND item.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM mail_items AS item
       WHERE item.tenant_id = mail_scans.tenant_id
         AND item.id = mail_scans.mail_item_id
         AND item.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
CREATE POLICY mail_scan_views_client_scope ON mail_scan_views AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM mail_scans AS scan
        JOIN mail_items AS item
          ON item.tenant_id = scan.tenant_id AND item.id = scan.mail_item_id
       WHERE scan.tenant_id = mail_scan_views.tenant_id
         AND scan.id = mail_scan_views.mail_scan_id
         AND item.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM mail_scans AS scan
        JOIN mail_items AS item
          ON item.tenant_id = scan.tenant_id AND item.id = scan.mail_item_id
       WHERE scan.tenant_id = mail_scan_views.tenant_id
         AND scan.id = mail_scan_views.mail_scan_id
         AND item.client_id = ANY (current_client_ids())
    )
  );

--> statement-breakpoint

-- Créneaux occupés du centre courant, sans rien de ce qui les occupe : ni objet,
-- ni client, ni demandeur. Ce que la page publique montre déjà, rendu lisible
-- depuis une transaction en portée client, qui ne voit que ses propres
-- réservations. Bornes `[)`, annulées exclues : le prédicat de la contrainte
-- d'exclusion.
CREATE FUNCTION booking_busy_ranges(
  p_from timestamptz,
  p_to timestamptz,
  p_resource_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (resource_id uuid, starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.resource_id, b.starts_at, b.ends_at
    FROM bookings AS b
   WHERE b.tenant_id = current_tenant_id()
     AND b.status <> 'cancelled'
     AND b.starts_at < p_to
     AND b.ends_at > p_from
     AND (p_resource_ids IS NULL OR b.resource_id = ANY (p_resource_ids))
   ORDER BY b.resource_id, b.starts_at
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION booking_busy_ranges(timestamptz, timestamptz, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION booking_busy_ranges(timestamptz, timestamptz, uuid[]) TO app_centre;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Conservation des demandes publiques (B4, ADR 005, ADR 020)
-- ---------------------------------------------------------------------------
-- Efface les coordonnées des demandeurs au terme de la durée du centre
-- (`tenants.public_request_retention_months`), comptée depuis la fin du créneau
-- demandé, ou depuis son annulation si elle est antérieure. Anonymiser, pas
-- supprimer : la réservation reste au planning et dans les statistiques
-- (décision 6), son canal dit toujours qu'elle venait de la page publique.
--
-- Une demande jamais rattachée à un client perd aussi son objet et ses notes,
-- saisis librement par le visiteur et susceptibles de le nommer. Rattachée à
-- un client, elle relève de l'historique de ce client : seules les
-- coordonnées du demandeur partent.
--
-- Même modèle que `purge_expired_mail_scan_views()` (migration 0024) :
-- l'application déclenche, la fonction seule choisit quoi.
CREATE FUNCTION anonymize_expired_public_requests() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH anonymized AS (
    UPDATE bookings AS b
       SET requester_name = NULL,
           requester_email = NULL,
           requester_phone = NULL,
           requester_anonymized_at = now(),
           notes = CASE WHEN b.client_id IS NULL THEN NULL ELSE b.notes END,
           title = CASE WHEN b.client_id IS NULL THEN 'Demande publique anonymisée' ELSE b.title END
      FROM tenants AS t
     WHERE t.id = current_tenant_id()
       AND b.tenant_id = t.id
       AND (b.requester_name IS NOT NULL
            OR b.requester_email IS NOT NULL
            OR b.requester_phone IS NOT NULL)
       AND CASE WHEN b.status = 'cancelled' THEN least(b.cancelled_at, b.ends_at) ELSE b.ends_at END
           < now() - make_interval(months => t.public_request_retention_months)
    RETURNING 1
  )
  SELECT count(*)::integer FROM anonymized
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION anonymize_expired_public_requests() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_expired_public_requests() TO app_centre;
