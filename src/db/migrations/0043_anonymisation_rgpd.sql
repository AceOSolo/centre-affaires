-- Vague 3 (ADR 040) : anonymisation RGPD des clients, contacts, accès et
-- membres de l'équipe retirés (R29, partie code).
--
-- Anonymiser, jamais supprimer (décision 6) : la ligne reste, ses champs
-- personnels partent. Les factures émises, leurs lignes et leurs instantanés
-- d'acheteur ne sont jamais touchés : obligation de conservation de 10 ans
-- (art. L.123-22 du Code de commerce). Les documents de contrat archivés et
-- le journal des relances non plus : pièces justificatives (ADR 028, 034).
--
-- Même modèle que `anonymize_expired_public_requests()` (migration 0026) :
-- fonctions SECURITY DEFINER, filtre explicite sur `current_tenant_id()`,
-- `search_path` figé ; l'application déclenche, la fonction choisit quoi.
-- Refusées sous portée client : c'est une tâche du back-office (CA012).
--
-- 1. Garde des lignes anonymisées : `anonymized_at` n'est posé que par ces
--    fonctions, et une ligne anonymisée ne change plus (CA012).
-- 2. Fin de la relation : `client_last_activity_on()`.
-- 3. Exclusions : `client_anonymization_blockers()`.
-- 4. Anonymisation d'un client, à la demande ou au terme de sa durée.
-- 5. Anonymisation des membres retirés (équipe et espace client).

-- ---------------------------------------------------------------------------
-- 1. Garde des lignes anonymisées
-- ---------------------------------------------------------------------------
CREATE FUNCTION anonymized_rows_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.anonymization', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.anonymized_at IS NOT NULL THEN
      RAISE EXCEPTION 'L''anonymisation est posée par la base (fonctions anonymize_*), jamais à l''écriture.'
        USING ERRCODE = 'CA012';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at THEN
    RAISE EXCEPTION 'L''anonymisation est posée par la base (fonctions anonymize_*) : elle ne s''écrit ni ne s''efface.'
      USING ERRCODE = 'CA012';
  END IF;
  IF OLD.anonymized_at IS NOT NULL
     AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'Cette ligne a été anonymisée le % : elle ne change plus.', to_char(OLD.anonymized_at, 'DD/MM/YYYY')
      USING ERRCODE = 'CA012';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER clients_guard_anonymized
BEFORE INSERT OR UPDATE ON clients
FOR EACH ROW EXECUTE FUNCTION anonymized_rows_guard();
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_anonymized
BEFORE INSERT OR UPDATE ON client_contacts
FOR EACH ROW EXECUTE FUNCTION anonymized_rows_guard();
--> statement-breakpoint
CREATE TRIGGER client_members_guard_anonymized
BEFORE INSERT OR UPDATE ON client_members
FOR EACH ROW EXECUTE FUNCTION anonymized_rows_guard();
--> statement-breakpoint
CREATE TRIGGER staff_members_guard_anonymized
BEFORE INSERT OR UPDATE ON staff_members
FOR EACH ROW EXECUTE FUNCTION anonymized_rows_guard();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Fin de la relation
-- ---------------------------------------------------------------------------
-- Dernier jour d'activité d'une entreprise, jour civil du centre : la date
-- dont part la durée de conservation (prospect sans contact, client après la
-- fin de la relation). Le plus tardif de :
--
-- - la création de la fiche, et le dernier contact noté (`last_contact_on`) ;
-- - pour chaque contrat : son dernier jour (le plus proche de la fin et de la
--   résiliation), aujourd'hui s'il est sans terme, la date de sa dernière
--   modification s'il est brouillon, la date d'archivage s'il est archivé ;
-- - la fin de la dernière réservation, ou son annulation si elle est
--   antérieure ;
-- - la réception du dernier pli et la dernière demande de courrier ;
-- - la dernière facture émise et le dernier paiement pointé ;
-- - le dernier état des lieux.
--
-- NULL pour un client inconnu du centre courant. Sous les politiques de
-- l'appelant (le back-office voit tout le centre).
CREATE FUNCTION client_last_activity_on(p_client_id uuid) RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH c AS (
    SELECT cl.id, cl.tenant_id, cl.created_at, cl.last_contact_on, t.timezone
      FROM clients AS cl
      JOIN tenants AS t ON t.id = cl.tenant_id
     WHERE cl.id = p_client_id AND cl.tenant_id = current_tenant_id()
  )
  SELECT greatest(
    (c.created_at AT TIME ZONE c.timezone)::date,
    c.last_contact_on,
    (SELECT max(CASE
                  WHEN k.deleted_at IS NOT NULL THEN (k.deleted_at AT TIME ZONE c.timezone)::date
                  WHEN k.status = 'draft' THEN (k.updated_at AT TIME ZONE c.timezone)::date
                  ELSE coalesce(least(k.ends_on, k.terminated_on), (now() AT TIME ZONE c.timezone)::date)
                END)
       FROM contracts AS k
      WHERE k.tenant_id = c.tenant_id AND k.client_id = c.id),
    (SELECT max(((CASE WHEN b.status = 'cancelled' THEN least(b.cancelled_at, b.ends_at) ELSE b.ends_at END)
                 AT TIME ZONE c.timezone)::date)
       FROM bookings AS b
      WHERE b.tenant_id = c.tenant_id AND b.client_id = c.id AND b.kind = 'booking'),
    (SELECT max((m.received_at AT TIME ZONE c.timezone)::date)
       FROM mail_items AS m
      WHERE m.tenant_id = c.tenant_id AND m.client_id = c.id),
    (SELECT max((r.requested_at AT TIME ZONE c.timezone)::date)
       FROM mail_requests AS r
      WHERE r.tenant_id = c.tenant_id AND r.client_id = c.id),
    (SELECT max(i.issue_date)
       FROM invoices AS i
      WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id AND i.status <> 'draft'),
    (SELECT max(p.paid_on)
       FROM payments AS p
       JOIN invoices AS i ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id
      WHERE p.tenant_id = c.tenant_id AND i.client_id = c.id AND p.cancelled_at IS NULL),
    (SELECT max((x.performed_at AT TIME ZONE c.timezone)::date)
       FROM inspections AS x
      WHERE x.tenant_id = c.tenant_id AND x.client_id = c.id AND x.deleted_at IS NULL)
  )
  FROM c
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Exclusions
-- ---------------------------------------------------------------------------
-- Ce qui empêche d'anonymiser une entreprise, en phrases pour l'écran ;
-- tableau vide : rien ne l'empêche. NULL pour un client inconnu du centre.
--
-- Une relation vivante, ou une obligation en cours, n'est jamais anonymisée :
-- facture non soldée ou brouillon de facture, contrat vivant (brouillon, en
-- cours, ou résilié à une date à venir), réservation à venir ou en cours,
-- service souscrit en cours, mandat de prélèvement actif, demande de courrier
-- en cours, état des lieux en saisie. Une fiche déjà anonymisée ne l'est pas
-- deux fois.
CREATE FUNCTION client_anonymization_blockers(p_client_id uuid) RETURNS text[]
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH c AS (
    SELECT cl.id, cl.tenant_id, cl.anonymized_at, (now() AT TIME ZONE t.timezone)::date AS today
      FROM clients AS cl
      JOIN tenants AS t ON t.id = cl.tenant_id
     WHERE cl.id = p_client_id AND cl.tenant_id = current_tenant_id()
  )
  SELECT array_remove(ARRAY[
    CASE WHEN c.anonymized_at IS NOT NULL THEN 'Fiche déjà anonymisée.' END,
    (SELECT 'Facture non soldée : ' || string_agg(i.number, ', ' ORDER BY i.number) || '.'
       FROM invoices AS i
      WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id AND i.kind = 'invoice'
        AND i.status IN ('issued', 'partially_paid') AND i.deleted_at IS NULL
     HAVING count(*) > 0),
    (SELECT 'Brouillon de facture ou d''avoir à émettre ou à abandonner.'
       FROM invoices AS i
      WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id
        AND i.status = 'draft' AND i.deleted_at IS NULL
     HAVING count(*) > 0),
    (SELECT 'Contrat vivant : ' || string_agg(k.reference, ', ' ORDER BY k.reference) || '.'
       FROM contracts AS k
      WHERE k.tenant_id = c.tenant_id AND k.client_id = c.id AND k.deleted_at IS NULL
        AND (k.status = 'draft'
             OR coalesce(least(k.ends_on, k.terminated_on), 'infinity'::date) >= c.today)
     HAVING count(*) > 0),
    (SELECT 'Réservation à venir ou en cours.'
       FROM bookings AS b
      WHERE b.tenant_id = c.tenant_id AND b.client_id = c.id AND b.kind = 'booking'
        AND b.status <> 'cancelled' AND b.ends_at > now()
     HAVING count(*) > 0),
    (SELECT 'Service souscrit en cours.'
       FROM subscribed_services AS s
      WHERE s.tenant_id = c.tenant_id AND s.client_id = c.id AND s.deleted_at IS NULL
        AND (s.ends_on IS NULL OR s.ends_on >= c.today)
     HAVING count(*) > 0),
    (SELECT 'Mandat de prélèvement actif.'
       FROM sepa_mandates AS m
      WHERE m.tenant_id = c.tenant_id AND m.client_id = c.id
        AND m.status = 'active' AND m.deleted_at IS NULL
     HAVING count(*) > 0),
    (SELECT 'Demande de courrier en cours.'
       FROM mail_requests AS r
      WHERE r.tenant_id = c.tenant_id AND r.client_id = c.id
        AND r.status IN ('requested', 'in_progress')
     HAVING count(*) > 0),
    (SELECT 'État des lieux en saisie.'
       FROM inspections AS x
      WHERE x.tenant_id = c.tenant_id AND x.client_id = c.id
        AND x.status = 'draft' AND x.deleted_at IS NULL
     HAVING count(*) > 0)
  ], NULL)
  FROM c
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Anonymisation d'un client
-- ---------------------------------------------------------------------------
-- Le geste lui-même, sans contrôle : réservé aux fonctions qui suivent, qui
-- vérifient le centre, la portée et les exclusions. Ce qui part :
--
-- - la fiche : raison sociale remplacée (« Client anonymisé » et le début de
--   l'identifiant, pour distinguer deux fiches dans un historique), forme,
--   SIRET, TVA, coordonnées, adresse, notes, dernier contact ; passée
--   `inactive`, archivée. Le compte auxiliaire (`accounting_code`) reste :
--   les écritures comptables des exercices passés le citent ;
-- - ses contacts et ses accès : noms, coordonnées, notes ; les accès sont
--   détachés de leur compte et reçoivent une adresse inexistante
--   (`.invalid`, RFC 2606) ;
-- - ses plis : expéditeur et note ; ses demandes de courrier : consigne et
--   adresse de réexpédition ;
-- - ses réservations : coordonnées de demandeur et notes (l'objet reste) ;
-- - ses contrats : notes et motif de résiliation ;
-- - ses mandats non actifs : le nom du titulaire (l'IBAN reste chiffré, sa
--   durée propre est à construire, ADR 034) ;
-- - les messages journalisés à son sujet : destinataires et objet.
--
-- Restent intacts : factures, avoirs, lignes, paiements, instantanés,
-- relances, documents de contrat, états des lieux (pièces probantes).
CREATE FUNCTION anonymize_client_rows(c clients) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.anonymization', true), '');
BEGIN
  PERFORM set_config('app.anonymization', 'on', true);

  UPDATE clients
     SET name = 'Client anonymisé ' || left(c.id::text, 8),
         legal_form = NULL, siret = NULL, vat_number = NULL,
         email = NULL, phone = NULL,
         address_line1 = NULL, address_line2 = NULL, postal_code = NULL, city = NULL,
         notes = NULL, last_contact_on = NULL,
         status = 'inactive',
         anonymized_at = now(),
         deleted_at = coalesce(deleted_at, now())
   WHERE tenant_id = c.tenant_id AND id = c.id;

  UPDATE client_contacts
     SET full_name = 'Contact anonymisé', job_title = NULL, email = NULL, phone = NULL,
         notes = NULL, is_primary = false, is_billing = false,
         anonymized_at = now(),
         deleted_at = coalesce(deleted_at, now())
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND anonymized_at IS NULL;

  UPDATE client_members
     SET email = 'anonyme-' || id::text || '@anonymise.invalid',
         full_name = 'Personne anonymisée',
         auth_user_id = NULL,
         anonymized_at = now(),
         deleted_at = coalesce(deleted_at, now())
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND anonymized_at IS NULL;

  UPDATE mail_items
     SET sender = NULL, note = NULL, sender_anonymized_at = now()
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND sender_anonymized_at IS NULL;

  UPDATE mail_requests
     SET client_note = NULL,
         forward_recipient = CASE WHEN kind = 'forward' THEN 'Destinataire anonymisé' END,
         forward_address_line1 = CASE WHEN kind = 'forward' THEN 'Adresse anonymisée' END,
         forward_address_line2 = NULL
   WHERE tenant_id = c.tenant_id AND client_id = c.id;

  UPDATE bookings
     SET requester_name = NULL, requester_email = NULL, requester_phone = NULL,
         requester_anonymized_at = CASE
           WHEN num_nonnulls(requester_name, requester_email, requester_phone) > 0
             THEN coalesce(requester_anonymized_at, now())
           ELSE requester_anonymized_at
         END,
         notes = NULL
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND kind <> 'contract'
     AND (num_nonnulls(requester_name, requester_email, requester_phone, notes) > 0);

  UPDATE contracts
     SET notes = NULL, termination_reason = NULL
   WHERE tenant_id = c.tenant_id AND client_id = c.id
     AND num_nonnulls(notes, termination_reason) > 0;

  UPDATE sepa_mandates
     SET debtor_name = 'Titulaire anonymisé'
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND status <> 'active'
     AND debtor_name <> 'Titulaire anonymisé';

  UPDATE notification_deliveries
     SET recipients = array_fill('destinataire@anonymise.invalid'::text, ARRAY[cardinality(recipients)]),
         failed_recipients = array_fill('destinataire@anonymise.invalid'::text, ARRAY[cardinality(failed_recipients)]),
         subject = 'Objet anonymisé'
   WHERE tenant_id = c.tenant_id AND client_id = c.id;

  PERFORM set_config('app.anonymization', v_previous, true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client_rows(clients) FROM PUBLIC;

--> statement-breakpoint

-- Anonymisation d'une entreprise à la demande (droit à l'effacement, fin de
-- relation constatée) : sans attendre sa durée, mais jamais contre une
-- exclusion — refus CA012, le message les énumère. La fiche est verrouillée
-- le temps du geste : une réservation ou une facture créée en même temps
-- attend, puis voit la fiche archivée.
CREATE FUNCTION anonymize_client(p_client_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_client clients%ROWTYPE;
  v_blockers text[];
BEGIN
  IF current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'Anonymisation impossible hors du contexte d''un centre (app.tenant_id).'
      USING ERRCODE = 'CA012';
  END IF;
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  SELECT * INTO v_client FROM clients
   WHERE tenant_id = current_tenant_id() AND id = p_client_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client introuvable dans ce centre.' USING ERRCODE = 'CA012';
  END IF;
  v_blockers := client_anonymization_blockers(p_client_id);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'Anonymisation refusée : %', array_to_string(v_blockers, ' ')
      USING ERRCODE = 'CA012',
            HINT = 'Soldez ou annulez par avoir, terminez les contrats et services, révoquez le mandat, traitez les demandes, puis recommencez.';
  END IF;
  PERFORM anonymize_client_rows(v_client);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_client(uuid) TO app_centre;

--> statement-breakpoint

-- Anonymisation au terme des durées du centre (tâche nocturne) : un prospect
-- dont la dernière activité date de plus de `prospect_retention_months`, un
-- client (actif ou inactif) dont la relation a pris fin depuis plus de
-- `client_retention_months`. Les entreprises sous exclusion sont passées
-- sans erreur ; une fiche verrouillée par une autre transaction l'est au
-- passage suivant. Rend le nombre d'entreprises anonymisées.
CREATE FUNCTION anonymize_expired_clients() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant tenants%ROWTYPE;
  v_today date;
  v_client clients%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  SELECT * INTO v_tenant FROM tenants WHERE id = current_tenant_id();
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_today := (now() AT TIME ZONE v_tenant.timezone)::date;

  FOR v_client IN
    SELECT * FROM clients
     WHERE tenant_id = v_tenant.id AND anonymized_at IS NULL
     ORDER BY created_at, id
     FOR UPDATE SKIP LOCKED
  LOOP
    CONTINUE WHEN client_last_activity_on(v_client.id) >= (
      v_today - make_interval(months => CASE
        WHEN v_client.status = 'prospect' THEN v_tenant.prospect_retention_months
        ELSE v_tenant.client_retention_months
      END)
    )::date;
    CONTINUE WHEN cardinality(client_anonymization_blockers(v_client.id)) > 0;
    PERFORM anonymize_client_rows(v_client);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_expired_clients() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_expired_clients() TO app_centre;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Membres retirés : équipe et espace client
-- ---------------------------------------------------------------------------
-- Un membre retiré garde sa ligne : elle signe des plis, des numérisations,
-- des factures, des demandes, des consultations. Au terme de
-- `removed_member_retention_months` après son retrait, son nom et son adresse
-- partent, son compte est détaché. Un membre actif ne s'anonymise pas : il
-- faut d'abord le retirer.
CREATE FUNCTION anonymize_member_rows(p_table text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.anonymization', true), '');
  v_done boolean;
BEGIN
  PERFORM set_config('app.anonymization', 'on', true);
  IF p_table = 'client_members' THEN
    UPDATE client_members
       SET email = 'anonyme-' || id::text || '@anonymise.invalid',
           full_name = 'Personne anonymisée', auth_user_id = NULL, anonymized_at = now()
     WHERE tenant_id = current_tenant_id() AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
  ELSE
    UPDATE staff_members
       SET email = 'anonyme-' || id::text || '@anonymise.invalid',
           full_name = 'Membre anonymisé', auth_user_id = NULL, anonymized_at = now()
     WHERE tenant_id = current_tenant_id() AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
  END IF;
  v_done := FOUND;
  PERFORM set_config('app.anonymization', v_previous, true);
  RETURN v_done;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_member_rows(text, uuid) FROM PUBLIC;

--> statement-breakpoint

-- Membres retirés depuis plus que la durée du centre, des deux populations.
-- Rend le nombre de membres anonymisés.
CREATE FUNCTION anonymize_removed_members() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant tenants%ROWTYPE;
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  SELECT * INTO v_tenant FROM tenants WHERE id = current_tenant_id();
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  FOR v_id IN
    SELECT id FROM client_members
     WHERE tenant_id = v_tenant.id AND anonymized_at IS NULL AND deleted_at IS NOT NULL
       AND deleted_at < now() - make_interval(months => v_tenant.removed_member_retention_months)
  LOOP
    IF anonymize_member_rows('client_members', v_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  FOR v_id IN
    SELECT id FROM staff_members
     WHERE tenant_id = v_tenant.id AND anonymized_at IS NULL AND deleted_at IS NOT NULL
       AND deleted_at < now() - make_interval(months => v_tenant.removed_member_retention_months)
  LOOP
    IF anonymize_member_rows('staff_members', v_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_removed_members() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_removed_members() TO app_centre;

--> statement-breakpoint

-- À la demande, sans attendre la durée : un accès client, ou un membre de
-- l'équipe, déjà retiré (refus CA012 sinon).
CREATE FUNCTION anonymize_client_member(p_member_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  IF NOT anonymize_member_rows('client_members', p_member_id) THEN
    RAISE EXCEPTION 'Seul un accès retiré, et pas encore anonymisé, s''anonymise : retirez-le d''abord.'
      USING ERRCODE = 'CA012';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_client_member(uuid) TO app_centre;

--> statement-breakpoint

CREATE FUNCTION anonymize_staff_member(p_staff_member_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  IF NOT anonymize_member_rows('staff_members', p_staff_member_id) THEN
    RAISE EXCEPTION 'Seul un membre retiré de l''équipe, et pas encore anonymisé, s''anonymise : retirez-le d''abord.'
      USING ERRCODE = 'CA012';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_staff_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_staff_member(uuid) TO app_centre;
