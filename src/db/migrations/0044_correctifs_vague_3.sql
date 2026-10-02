-- Correctifs de la dernière vague (ADR 041) : table des demandes d'offre,
-- confirmation datée des réservations, anonymisation tracée, nom figé des
-- versions de modèle d'état des lieux, réserves bornées. Partie générée par
-- Drizzle d'abord, puis ce qu'il ne sait pas décrire (section en fin de fichier).

CREATE TYPE "public"."anonymization_basis" AS ENUM('retention', 'erasure_request', 'relationship_ended');--> statement-breakpoint
CREATE TYPE "public"."offer_request_status" AS ENUM('requested', 'contracted', 'dismissed');--> statement-breakpoint
CREATE TABLE "offer_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "offer_request_status" DEFAULT 'requested' NOT NULL,
	"contract_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_staff_id" uuid,
	"dismissal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_requests_status_consistent" CHECK (case "offer_requests"."status"
        when 'requested' then num_nonnulls("offer_requests"."contract_id", "offer_requests"."closed_at", "offer_requests"."closed_by_staff_id", "offer_requests"."dismissal_reason") = 0
        when 'contracted' then "offer_requests"."contract_id" is not null and "offer_requests"."closed_at" is not null and "offer_requests"."dismissal_reason" is null
        else "offer_requests"."contract_id" is null and "offer_requests"."closed_at" is not null
      end),
	CONSTRAINT "offer_requests_dismissal_reason_length" CHECK ("offer_requests"."dismissal_reason" is null or char_length("offer_requests"."dismissal_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "anonymized_by" uuid;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "anonymization_basis" "anonymization_basis";--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "erasure_requested_on" date;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "confirmed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "client_members" ADD COLUMN "anonymized_by" uuid;--> statement-breakpoint
ALTER TABLE "client_members" ADD COLUMN "anonymization_basis" "anonymization_basis";--> statement-breakpoint
ALTER TABLE "client_members" ADD COLUMN "erasure_requested_on" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "anonymized_by" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "anonymization_basis" "anonymization_basis";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "erasure_requested_on" date;--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ADD COLUMN "name" text;--> statement-breakpoint
-- Le nom figé avec chaque version existante : celui du modèle aujourd'hui (ADR 041).
UPDATE "inspection_template_versions" AS v SET "name" = t."name" FROM "inspection_templates" AS t WHERE t."tenant_id" = v."tenant_id" AND t."id" = v."template_id";--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_closed_by_staff_id_staff_members_id_fk" FOREIGN KEY ("closed_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_requested_by_member_fk" FOREIGN KEY ("tenant_id","client_id","requested_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_requests" ADD CONSTRAINT "offer_requests_contract_fk" FOREIGN KEY ("tenant_id","contract_id","client_id") REFERENCES "public"."contracts"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_requests_open_key" ON "offer_requests" USING btree ("tenant_id","client_id","offer_id") WHERE status = 'requested';--> statement-breakpoint
CREATE INDEX "offer_requests_client_idx" ON "offer_requests" USING btree ("tenant_id","client_id","requested_at");--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_anonymized_by_staff_members_id_fk" FOREIGN KEY ("anonymized_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_by_staff_id_staff_members_id_fk" FOREIGN KEY ("confirmed_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_anonymized_by_staff_members_id_fk" FOREIGN KEY ("anonymized_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_anonymized_by_staff_members_id_fk" FOREIGN KEY ("anonymized_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_anonymization_traced" CHECK (("staff_members"."anonymized_at" is not null or num_nonnulls("staff_members"."anonymized_by", "staff_members"."anonymization_basis", "staff_members"."erasure_requested_on") = 0)
    and ("staff_members"."erasure_requested_on" is null) = ("staff_members"."anonymization_basis" is distinct from 'erasure_request')
    and ("staff_members"."anonymization_basis" is null or ("staff_members"."anonymized_by" is null) = ("staff_members"."anonymization_basis" = 'retention')));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_by_consistent" CHECK ("bookings"."confirmed_by_staff_id" is null or "bookings"."confirmed_at" is not null);--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_anonymization_traced" CHECK (("client_members"."anonymized_at" is not null or num_nonnulls("client_members"."anonymized_by", "client_members"."anonymization_basis", "client_members"."erasure_requested_on") = 0)
    and ("client_members"."erasure_requested_on" is null) = ("client_members"."anonymization_basis" is distinct from 'erasure_request')
    and ("client_members"."anonymization_basis" is null or ("client_members"."anonymized_by" is null) = ("client_members"."anonymization_basis" = 'retention')));--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_anonymization_traced" CHECK (("clients"."anonymized_at" is not null or num_nonnulls("clients"."anonymized_by", "clients"."anonymization_basis", "clients"."erasure_requested_on") = 0)
    and ("clients"."erasure_requested_on" is null) = ("clients"."anonymization_basis" is distinct from 'erasure_request')
    and ("clients"."anonymization_basis" is null or ("clients"."anonymized_by" is null) = ("clients"."anonymization_basis" = 'retention')));--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ADD CONSTRAINT "inspection_template_versions_name_not_blank" CHECK (btrim("inspection_template_versions"."name") <> '');--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_client_remarks_length" CHECK ("inspections"."client_remarks" is null or char_length("inspections"."client_remarks") <= 2000);
--> statement-breakpoint

-- ===========================================================================
-- Correctifs de la dernière vague (ADR 041) : ce que Drizzle ne sait pas
-- décrire.
--
-- 1. Compte auxiliaire figé à l'anonymisation : `derive_accounting_code()`,
--    jumeau de `deriveAccountingCode` (fec.ts).
-- 2. Anonymisation tracée : auteur, fondement et date de la demande
--    d'effacement (R29, art. 5-2 et 12-3 du RGPD).
-- 3. Demandes d'offre : isolation, garde (CA013), fin de relation et
--    exclusion de l'anonymisation.
-- 4. Confirmation des réservations datée par la base (R24).
-- 5. Photos d'états des lieux rechiffrées à la rotation de clé (R33).
--
-- Mêmes règles que les migrations 0041 à 0043 : RLS en ENABLE et FORCE,
-- `search_path` figé, drapeaux de session sauvegardés puis restaurés.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Compte auxiliaire dérivé de la raison sociale
-- ---------------------------------------------------------------------------
-- Même règle que `deriveAccountingCode` (src/modules/facturation/fec.ts) :
-- décomposition NFD, diacritiques retirés, majuscules, seulement chiffres et
-- lettres A à Z, 17 caractères au plus, « CLIENT » si rien ne reste. Les
-- majuscules de JavaScript qui donnent des lettres latines à partir d'autres
-- caractères (ß, ı, ſ, ligatures…) sont reprises une à une ; le reste passe en
-- majuscules par `translate`, indépendant de la collation. Un test compare les
-- deux sur ces caractères (`comptabilite-anonymisation.db.test.ts`).
CREATE FUNCTION derive_accounting_code(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(nullif(left(translate(regexp_replace(
           replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
             regexp_replace(normalize(p_name, NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g'),
             'ß', 'SS'), 'ı', 'I'), 'ŉ', 'N'), 'ſ', 'S'), 'ẚ', 'A'), 'ﬀ', 'FF'),
             'ﬁ', 'FI'), 'ﬂ', 'FL'), 'ﬃ', 'FFI'), 'ﬄ', 'FFL'), 'ﬅ', 'ST'), 'ﬆ', 'ST'),
           '[^0-9A-Za-z]', '', 'g'),
         'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 17), ''), 'CLIENT')
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Anonymisation tracée
-- ---------------------------------------------------------------------------
-- Les fonctions de la migration 0043 changent de signature : l'anonymisation
-- à la demande porte son auteur et son fondement. Les anciennes disparaissent
-- pour qu'aucun appel ne passe sans eux.
DROP FUNCTION anonymize_client(uuid);
--> statement-breakpoint
DROP FUNCTION anonymize_client_member(uuid);
--> statement-breakpoint
DROP FUNCTION anonymize_staff_member(uuid);
--> statement-breakpoint
DROP FUNCTION anonymize_client_rows(clients);
--> statement-breakpoint
DROP FUNCTION anonymize_member_rows(text, uuid);

--> statement-breakpoint

-- Ce qu'une anonymisation à la demande doit dire (CA012) : son fondement —
-- demande d'effacement ou fin de la relation, jamais « au terme », qui est
-- celui de la tâche de nuit —, le membre vivant de l'équipe qui la décide, et
-- pour une demande d'effacement le jour où le centre l'a reçue, jamais à
-- venir. Un mois court depuis ce jour (art. 12-3 du RGPD).
CREATE FUNCTION anonymization_request_check(
  p_by uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_basis IS NULL OR p_basis = 'retention' THEN
    RAISE EXCEPTION 'Une anonymisation à la demande dit son fondement : demande d''effacement, ou fin de la relation constatée.'
      USING ERRCODE = 'CA012';
  END IF;
  IF p_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM staff_members
     WHERE tenant_id = current_tenant_id() AND id = p_by AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Une anonymisation à la demande porte le membre de l''équipe qui la décide.'
      USING ERRCODE = 'CA012';
  END IF;
  IF p_basis = 'erasure_request' AND p_erasure_requested_on IS NULL THEN
    RAISE EXCEPTION 'Une demande d''effacement se date : le jour où le centre l''a reçue.'
      USING ERRCODE = 'CA012';
  END IF;
  IF p_basis <> 'erasure_request' AND p_erasure_requested_on IS NOT NULL THEN
    RAISE EXCEPTION 'Seule une demande d''effacement porte une date de demande.' USING ERRCODE = 'CA012';
  END IF;
  IF p_erasure_requested_on > (
    SELECT (now() AT TIME ZONE timezone)::date FROM tenants WHERE id = current_tenant_id()
  ) THEN
    RAISE EXCEPTION 'La demande d''effacement ne peut pas être datée d''un jour à venir.' USING ERRCODE = 'CA012';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymization_request_check(uuid, anonymization_basis, date) FROM PUBLIC;

--> statement-breakpoint

-- Le geste lui-même, sans contrôle (voir la migration 0043), désormais tracé :
-- auteur (nul pour la nuit), fondement, date de la demande, posés sur la
-- fiche et sur les accès anonymisés avec elle.
--
-- Le compte auxiliaire est figé avant que la raison sociale ne parte : un
-- client facturé sans compte saisi garde celui que l'export lui donnait,
-- dérivé de son ancien nom (`derive_accounting_code`). Sans cela, tous les
-- clients anonymisés dériveraient le même compte de « Client anonymisé
-- 01… », l'export d'une période qui en compte deux serait refusé pour
-- toujours, et chaque export déjà remis changerait.
--
-- Les demandes d'offre perdent le motif d'un refus, saisi librement.
CREATE FUNCTION anonymize_client_rows(
  c clients,
  p_by uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.anonymization', true), '');
BEGIN
  PERFORM set_config('app.anonymization', 'on', true);

  -- Les expressions de SET lisent l'ancienne ligne : `name` est encore la
  -- raison sociale quand le compte en est dérivé.
  UPDATE clients
     SET accounting_code = coalesce(accounting_code, CASE
           WHEN EXISTS (
             SELECT 1 FROM invoices AS i
              WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id AND i.status <> 'draft'
           ) THEN derive_accounting_code(name)
         END),
         name = 'Client anonymisé ' || left(c.id::text, 8),
         legal_form = NULL, siret = NULL, vat_number = NULL,
         email = NULL, phone = NULL,
         address_line1 = NULL, address_line2 = NULL, postal_code = NULL, city = NULL,
         notes = NULL, last_contact_on = NULL,
         status = 'inactive',
         anonymized_at = now(),
         anonymized_by = p_by,
         anonymization_basis = p_basis,
         erasure_requested_on = p_erasure_requested_on,
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
         anonymized_by = p_by,
         anonymization_basis = p_basis,
         erasure_requested_on = p_erasure_requested_on,
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

  UPDATE offer_requests
     SET dismissal_reason = NULL
   WHERE tenant_id = c.tenant_id AND client_id = c.id AND dismissal_reason IS NOT NULL;

  UPDATE notification_deliveries
     SET recipients = array_fill('destinataire@anonymise.invalid'::text, ARRAY[cardinality(recipients)]),
         failed_recipients = array_fill('destinataire@anonymise.invalid'::text, ARRAY[cardinality(failed_recipients)]),
         subject = 'Objet anonymisé'
   WHERE tenant_id = c.tenant_id AND client_id = c.id;

  PERFORM set_config('app.anonymization', v_previous, true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client_rows(clients, uuid, anonymization_basis, date) FROM PUBLIC;

--> statement-breakpoint

-- À la demande (droit à l'effacement, fin de relation constatée) : sans
-- attendre sa durée, jamais contre une exclusion, avec son auteur et son
-- fondement (`anonymization_request_check`).
CREATE FUNCTION anonymize_client(
  p_client_id uuid,
  p_staff_member_id uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS void
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
  PERFORM anonymization_request_check(p_staff_member_id, p_basis, p_erasure_requested_on);
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
  PERFORM anonymize_client_rows(v_client, p_staff_member_id, p_basis, p_erasure_requested_on);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client(uuid, uuid, anonymization_basis, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_client(uuid, uuid, anonymization_basis, date) TO app_centre;

--> statement-breakpoint

-- La tâche de nuit : comme la migration 0043, au fondement « au terme », sans
-- auteur.
CREATE OR REPLACE FUNCTION anonymize_expired_clients() RETURNS integer
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
    PERFORM anonymize_client_rows(v_client, NULL, 'retention', NULL);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;

--> statement-breakpoint

-- Un accès ou un membre retiré, tracé comme une entreprise.
CREATE FUNCTION anonymize_member_rows(
  p_table text,
  p_id uuid,
  p_by uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS boolean
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
           full_name = 'Personne anonymisée', auth_user_id = NULL, anonymized_at = now(),
           anonymized_by = p_by, anonymization_basis = p_basis,
           erasure_requested_on = p_erasure_requested_on
     WHERE tenant_id = current_tenant_id() AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
  ELSE
    UPDATE staff_members
       SET email = 'anonyme-' || id::text || '@anonymise.invalid',
           full_name = 'Membre anonymisé', auth_user_id = NULL, anonymized_at = now(),
           anonymized_by = p_by, anonymization_basis = p_basis,
           erasure_requested_on = p_erasure_requested_on
     WHERE tenant_id = current_tenant_id() AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
  END IF;
  v_done := FOUND;
  PERFORM set_config('app.anonymization', v_previous, true);
  RETURN v_done;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_member_rows(text, uuid, uuid, anonymization_basis, date) FROM PUBLIC;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION anonymize_removed_members() RETURNS integer
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
    IF anonymize_member_rows('client_members', v_id, NULL, 'retention', NULL) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  FOR v_id IN
    SELECT id FROM staff_members
     WHERE tenant_id = v_tenant.id AND anonymized_at IS NULL AND deleted_at IS NOT NULL
       AND deleted_at < now() - make_interval(months => v_tenant.removed_member_retention_months)
  LOOP
    IF anonymize_member_rows('staff_members', v_id, NULL, 'retention', NULL) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;

--> statement-breakpoint

CREATE FUNCTION anonymize_client_member(
  p_member_id uuid,
  p_staff_member_id uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  PERFORM anonymization_request_check(p_staff_member_id, p_basis, p_erasure_requested_on);
  IF NOT anonymize_member_rows('client_members', p_member_id, p_staff_member_id, p_basis, p_erasure_requested_on) THEN
    RAISE EXCEPTION 'Seul un accès retiré, et pas encore anonymisé, s''anonymise : retirez-le d''abord.'
      USING ERRCODE = 'CA012';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_client_member(uuid, uuid, anonymization_basis, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_client_member(uuid, uuid, anonymization_basis, date) TO app_centre;

--> statement-breakpoint

CREATE FUNCTION anonymize_staff_member(
  p_staff_member_id uuid,
  p_by uuid,
  p_basis anonymization_basis,
  p_erasure_requested_on date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'L''anonymisation est une tâche du back-office.' USING ERRCODE = 'CA012';
  END IF;
  PERFORM anonymization_request_check(p_by, p_basis, p_erasure_requested_on);
  IF NOT anonymize_member_rows('staff_members', p_staff_member_id, p_by, p_basis, p_erasure_requested_on) THEN
    RAISE EXCEPTION 'Seul un membre retiré de l''équipe, et pas encore anonymisé, s''anonymise : retirez-le d''abord.'
      USING ERRCODE = 'CA012';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_staff_member(uuid, uuid, anonymization_basis, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_staff_member(uuid, uuid, anonymization_basis, date) TO app_centre;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Demandes d'offre
-- ---------------------------------------------------------------------------
ALTER TABLE offer_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE offer_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offer_requests_tenant_isolation ON offer_requests
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Portée client (ADR 019) : une entreprise ne voit et ne dépose que ses
-- demandes. RESTRICTIVE : en ET avec l'isolation par centre.
CREATE POLICY offer_requests_client_scope ON offer_requests AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Une demande ne se supprime pas : elle s'écarte (décision 6).
REVOKE DELETE, TRUNCATE ON offer_requests FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER offer_requests_set_updated_at
BEFORE UPDATE ON offer_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Garde de `offer_requests` (CA013) :
--
-- - une demande naît « à traiter », datée par la base, sur une offre
--   présentée dans l'espace client (vivante, `client_visible`) ;
-- - ne changent jamais : entreprise, offre, auteur, date ;
-- - se clôt une fois, au centre : par un contrat tiré de cette offre pour
--   cette entreprise (la clé étrangère tient l'entreprise), ou écartée par
--   un membre de l'équipe ; la date de clôture est posée par la base ;
-- - sous portée client, seul le dépôt passe ;
-- - ne se supprime pas.
--
-- `app.anonymization` laisse passer l'effacement du motif (ADR 040).
CREATE FUNCTION offer_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_offer_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une demande d''offre ne se supprime pas : elle s''écarte, et sa trace reste.'
      USING ERRCODE = 'CA013';
  END IF;
  IF coalesce(current_setting('app.anonymization', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested'
       OR num_nonnulls(NEW.contract_id, NEW.closed_at, NEW.closed_by_staff_id, NEW.dismissal_reason) > 0 THEN
      RAISE EXCEPTION 'Une demande d''offre naît « à traiter » : le contrat ou le refus viennent ensuite.'
        USING ERRCODE = 'CA013';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM offers
       WHERE tenant_id = NEW.tenant_id AND id = NEW.offer_id
         AND deleted_at IS NULL AND client_visible
    ) THEN
      RAISE EXCEPTION 'Cette offre n''est pas proposée dans l''espace client.' USING ERRCODE = 'CA013';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.offer_id, NEW.requested_by_member_id, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.offer_id, OLD.requested_by_member_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'Une demande d''offre ne change ni d''entreprise, ni d''offre, ni d''auteur, ni de date.'
      USING ERRCODE = 'CA013';
  END IF;
  IF to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at' THEN
    RETURN NEW;
  END IF;
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'Une demande d''offre se traite au centre.' USING ERRCODE = 'CA013';
  END IF;
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'Cette demande d''offre est déjà traitée.' USING ERRCODE = 'CA013';
  END IF;
  IF NEW.status = 'contracted' THEN
    SELECT offer_id INTO v_offer_id FROM contracts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id;
    IF v_offer_id IS DISTINCT FROM NEW.offer_id THEN
      RAISE EXCEPTION 'Seul un contrat tiré de cette offre pour cette entreprise clôt la demande.'
        USING ERRCODE = 'CA013';
    END IF;
  ELSIF NEW.status = 'dismissed' THEN
    IF NEW.closed_by_staff_id IS NULL THEN
      RAISE EXCEPTION 'Une demande écartée porte le membre de l''équipe qui l''écarte.' USING ERRCODE = 'CA013';
    END IF;
  ELSE
    RAISE EXCEPTION 'Une demande d''offre « à traiter » passe à « contrat établi » ou « écartée ».'
      USING ERRCODE = 'CA013';
  END IF;
  NEW.closed_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER offer_requests_guard
BEFORE INSERT OR UPDATE OR DELETE ON offer_requests
FOR EACH ROW EXECUTE FUNCTION offer_requests_guard();

--> statement-breakpoint

-- Fin de la relation (migration 0043) : une demande d'offre est une activité
-- de l'entreprise.
CREATE OR REPLACE FUNCTION client_last_activity_on(p_client_id uuid) RETURNS date
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
    (SELECT max((o.requested_at AT TIME ZONE c.timezone)::date)
       FROM offer_requests AS o
      WHERE o.tenant_id = c.tenant_id AND o.client_id = c.id),
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

-- Exclusions (migration 0043) : une demande d'offre à traiter est une
-- relation vivante.
CREATE OR REPLACE FUNCTION client_anonymization_blockers(p_client_id uuid) RETURNS text[]
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
    (SELECT 'Demande d''offre à traiter.'
       FROM offer_requests AS o
      WHERE o.tenant_id = c.tenant_id AND o.client_id = c.id AND o.status = 'requested'
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
-- 4. Confirmation des réservations, datée par la base
-- ---------------------------------------------------------------------------
-- `confirmed_at` est posé quand la réservation devient confirmée : à sa
-- création (accueil, confirmation immédiate depuis l'espace client,
-- occupation de contrat), ou quand l'accueil accepte une demande — le code
-- dit alors qui (`confirmed_by_staff_id`). Il ne se réécrit pas ensuite.
-- Les réservations confirmées avant cette migration gardent une
-- confirmation sans date.
--
-- Nommé pour passer après `bookings_apply_client_booking_mode`, qui pose le
-- statut d'une réservation du portail (les déclencheurs BEFORE d'une table
-- s'exécutent dans l'ordre de leur nom).
CREATE FUNCTION bookings_stamp_confirmation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.confirmed_at := CASE WHEN NEW.status = 'confirmed' THEN now() END;
    RETURN NEW;
  END IF;
  IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' THEN
    NEW.confirmed_at := now();
  ELSIF (NEW.confirmed_at, NEW.confirmed_by_staff_id)
        IS DISTINCT FROM (OLD.confirmed_at, OLD.confirmed_by_staff_id) THEN
    RAISE EXCEPTION 'La confirmation d''une réservation est datée par la base : elle ne se réécrit pas.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_stamp_confirmation
BEFORE INSERT OR UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION bookings_stamp_confirmation();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Photos d'états des lieux : rechiffrement à la rotation de clé
-- ---------------------------------------------------------------------------
-- La garde de la migration 0042, avec un passage de plus : sous
-- `app.inspection_photo_rekey`, posé par `rekey_inspection_photo()` seule,
-- une photo — d'un état des lieux clos compris — change de version de clé, et
-- de rien d'autre. Le fichier, réécrit à la même clé de stockage avec la clé
-- courante, l'a précédée (`etats-des-lieux/rechiffrement.ts`).
CREATE OR REPLACE FUNCTION inspection_photos_guard() RETURNS trigger
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
  IF coalesce(current_setting('app.inspection_photo_rekey', true), '') = 'on' THEN
    IF TG_OP <> 'UPDATE'
       OR to_jsonb(NEW) - '{encryption_key_version,updated_at}'::text[]
          IS DISTINCT FROM to_jsonb(OLD) - '{encryption_key_version,updated_at}'::text[] THEN
      RAISE EXCEPTION 'Le rechiffrement d''une photo ne change que sa version de clé.' USING ERRCODE = 'CA010';
    END IF;
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

-- Une photo vivante passe de la clé `p_from_version` à `p_to_version`, une
-- fois son fichier réécrit. Faux si elle a changé entre-temps (purgée,
-- rechiffrée par une autre reprise). Refusée sous portée client (CA010).
CREATE FUNCTION rekey_inspection_photo(
  p_photo_id uuid,
  p_from_version integer,
  p_to_version integer
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.inspection_photo_rekey', true), '');
  v_done boolean;
BEGIN
  IF current_client_ids() IS NOT NULL THEN
    RAISE EXCEPTION 'Le rechiffrement des photos est une tâche du centre.' USING ERRCODE = 'CA010';
  END IF;
  IF p_to_version IS NULL OR p_to_version < 1 OR p_to_version = p_from_version THEN
    RAISE EXCEPTION 'Version de clé de destination invalide : %.', p_to_version USING ERRCODE = 'CA010';
  END IF;
  PERFORM set_config('app.inspection_photo_rekey', 'on', true);
  UPDATE inspection_photos
     SET encryption_key_version = p_to_version
   WHERE tenant_id = current_tenant_id() AND id = p_photo_id
     AND encryption_key_version = p_from_version AND deleted_at IS NULL;
  v_done := FOUND;
  PERFORM set_config('app.inspection_photo_rekey', v_previous, true);
  RETURN v_done;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rekey_inspection_photo(uuid, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rekey_inspection_photo(uuid, integer, integer) TO app_centre;
