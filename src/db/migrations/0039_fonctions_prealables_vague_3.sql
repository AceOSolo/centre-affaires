-- Vague 3 (ADR 036 à 040) : fonctions pures dont se servent des contraintes
-- `check` de la migration 0040, posées avant les tables comme les règles
-- d'arrondi avant les factures (migration 0029).
--
-- Elles prennent du texte ou du JSON, pas les énumérations de la vague : les
-- types n'existent pas encore. IMMUTABLE : elles servent à des contraintes.
-- Les changer demande de revérifier les lignes existantes (nouvelle
-- migration, nouvel ADR).

-- ---------------------------------------------------------------------------
-- 1. Notifications (R26, ADR 038)
-- ---------------------------------------------------------------------------
-- Erreur commune des deux fonctions suivantes.
CREATE FUNCTION notification_event_unknown(p_event text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RAISE EXCEPTION 'Événement de notification inconnu : « % ». Classez-le dans notification_event_audience() et notification_event_category().', p_event;
END
$$;

--> statement-breakpoint

-- À qui s'adresse un événement : `client` (les personnes de l'entreprise) ou
-- `centre` (l'adresse du centre). Un événement inconnu lève une erreur : une
-- valeur ajoutée à l'énumération sans être classée ici fait échouer
-- l'écriture au lieu de passer la contrainte (un `NULL` la satisferait).
-- Miroir : `notificationEventAudience` (src/modules/notifications/schema.ts).
CREATE FUNCTION notification_event_audience(p_event text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN CASE p_event
    WHEN 'mail_received' THEN 'client'
    WHEN 'mail_scanned' THEN 'client'
    WHEN 'mail_request_submitted' THEN 'centre'
    WHEN 'mail_request_done' THEN 'client'
    WHEN 'mail_request_refused' THEN 'client'
    WHEN 'booking_request_submitted' THEN 'centre'
    WHEN 'booking_request_accepted' THEN 'client'
    WHEN 'booking_request_refused' THEN 'client'
    WHEN 'booking_confirmed' THEN 'client'
    WHEN 'booking_cancelled' THEN 'client'
    WHEN 'invoice_issued' THEN 'client'
    WHEN 'invoice_reminder' THEN 'client'
    WHEN 'contract_activated' THEN 'client'
    WHEN 'inspection_to_sign' THEN 'client'
    WHEN 'inspection_signed' THEN 'centre'
    WHEN 'member_invited' THEN 'client'
    WHEN 'offer_requested' THEN 'centre'
    ELSE notification_event_unknown(p_event)
  END;
END
$$;

--> statement-breakpoint

-- Catégorie de préférence d'un événement, ou NULL : l'événement part
-- toujours (accès ouvert, messages au centre). Miroir :
-- `notificationEventCategory`.
CREATE FUNCTION notification_event_category(p_event text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN CASE p_event
    WHEN 'mail_received' THEN 'mail'
    WHEN 'mail_scanned' THEN 'mail'
    WHEN 'mail_request_done' THEN 'mail'
    WHEN 'mail_request_refused' THEN 'mail'
    WHEN 'booking_request_accepted' THEN 'bookings'
    WHEN 'booking_request_refused' THEN 'bookings'
    WHEN 'booking_confirmed' THEN 'bookings'
    WHEN 'booking_cancelled' THEN 'bookings'
    WHEN 'invoice_issued' THEN 'invoices'
    WHEN 'invoice_reminder' THEN 'invoices'
    WHEN 'contract_activated' THEN 'contracts'
    WHEN 'inspection_to_sign' THEN 'inspections'
    WHEN 'mail_request_submitted' THEN NULL
    WHEN 'booking_request_submitted' THEN NULL
    WHEN 'inspection_signed' THEN NULL
    WHEN 'member_invited' THEN NULL
    WHEN 'offer_requested' THEN NULL
    ELSE notification_event_unknown(p_event)
  END;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. États des lieux (R06, ADR 039)
-- ---------------------------------------------------------------------------
-- Échelle de la note d'état (champ `condition`), du meilleur au pire.
-- Miroir : `inspectionConditionLevels` (src/modules/etats-des-lieux/schema.ts).
CREATE FUNCTION inspection_condition_levels() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['neuf', 'bon', 'usage', 'mauvais']
$$;

--> statement-breakpoint

-- Première erreur d'une liste de champs d'un modèle, ou NULL si elle est
-- valide. Le message est en français, pour l'écran du modèle. Règles :
-- `InspectionField` (src/modules/etats-des-lieux/schema.ts).
CREATE FUNCTION inspection_fields_error(p_fields jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_field jsonb;
  v_index integer := 0;
  v_ids text[] := '{}';
  v_id text;
  v_type text;
  v_key text;
  v_option jsonb;
  v_options text[];
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array' THEN
    RETURN 'Le modèle doit être une liste de champs.';
  END IF;
  IF jsonb_array_length(p_fields) = 0 THEN
    RETURN 'Le modèle doit compter au moins un champ.';
  END IF;
  IF jsonb_array_length(p_fields) > 100 THEN
    RETURN 'Un modèle compte au plus 100 champs.';
  END IF;

  FOR v_field IN SELECT value FROM jsonb_array_elements(p_fields) LOOP
    v_index := v_index + 1;
    IF jsonb_typeof(v_field) <> 'object' THEN
      RETURN format('Champ n° %s : un objet est attendu.', v_index);
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_field) LOOP
      IF v_key NOT IN ('id', 'label', 'type', 'required', 'unit', 'options', 'help') THEN
        RETURN format('Champ n° %s : propriété inconnue « %s ».', v_index, v_key);
      END IF;
    END LOOP;

    IF jsonb_typeof(v_field -> 'id') IS DISTINCT FROM 'string'
       OR (v_field ->> 'id') !~ '^[a-z][a-z0-9_]{0,62}$' THEN
      RETURN format('Champ n° %s : identifiant invalide (une lettre minuscule, puis minuscules, chiffres ou _).', v_index);
    END IF;
    v_id := v_field ->> 'id';
    IF v_id = ANY (v_ids) THEN
      RETURN format('Champ « %s » : identifiant en double.', v_id);
    END IF;
    v_ids := v_ids || v_id;

    IF jsonb_typeof(v_field -> 'label') IS DISTINCT FROM 'string'
       OR btrim(v_field ->> 'label') = ''
       OR length(v_field ->> 'label') > 200 THEN
      RETURN format('Champ « %s » : libellé manquant ou de plus de 200 caractères.', v_id);
    END IF;

    v_type := v_field ->> 'type';
    IF jsonb_typeof(v_field -> 'type') IS DISTINCT FROM 'string'
       OR v_type NOT IN ('text', 'number', 'choice', 'checkbox', 'condition') THEN
      RETURN format('Champ « %s » : type inconnu (texte, nombre, choix, case ou note d''état).', v_id);
    END IF;

    IF jsonb_typeof(v_field -> 'required') IS DISTINCT FROM 'boolean' THEN
      RETURN format('Champ « %s » : dire s''il est obligatoire.', v_id);
    END IF;

    IF v_field ? 'unit' THEN
      IF v_type <> 'number' THEN
        RETURN format('Champ « %s » : seul un nombre a une unité.', v_id);
      END IF;
      IF jsonb_typeof(v_field -> 'unit') <> 'string'
         OR btrim(v_field ->> 'unit') = ''
         OR length(v_field ->> 'unit') > 20 THEN
        RETURN format('Champ « %s » : unité vide ou de plus de 20 caractères.', v_id);
      END IF;
    END IF;

    IF v_type = 'choice' THEN
      IF jsonb_typeof(v_field -> 'options') IS DISTINCT FROM 'array' THEN
        RETURN format('Champ « %s » : un choix liste ses options.', v_id);
      END IF;
      v_options := '{}';
      FOR v_option IN SELECT value FROM jsonb_array_elements(v_field -> 'options') LOOP
        IF jsonb_typeof(v_option) <> 'string'
           OR btrim(v_option #>> '{}') = ''
           OR length(v_option #>> '{}') > 100 THEN
          RETURN format('Champ « %s » : option vide ou de plus de 100 caractères.', v_id);
        END IF;
        IF (v_option #>> '{}') = ANY (v_options) THEN
          RETURN format('Champ « %s » : option « %s » en double.', v_id, v_option #>> '{}');
        END IF;
        v_options := v_options || (v_option #>> '{}');
      END LOOP;
      IF cardinality(v_options) NOT BETWEEN 2 AND 50 THEN
        RETURN format('Champ « %s » : un choix propose de 2 à 50 options.', v_id);
      END IF;
    ELSIF v_field ? 'options' THEN
      RETURN format('Champ « %s » : seul un choix a des options.', v_id);
    END IF;

    IF v_field ? 'help' AND (
         jsonb_typeof(v_field -> 'help') <> 'string'
         OR btrim(v_field ->> 'help') = ''
         OR length(v_field ->> 'help') > 500) THEN
      RETURN format('Champ « %s » : aide vide ou de plus de 500 caractères.', v_id);
    END IF;
  END LOOP;

  RETURN NULL;
END
$$;

--> statement-breakpoint

-- Première erreur des valeurs d'un état des lieux face aux champs de sa
-- version de modèle, ou NULL. Une valeur `null` ou absente vaut « non
-- renseigné ». Avec `p_complete` (clôture), chaque champ obligatoire doit
-- être renseigné — un texte, non vide.
--
-- texte : chaîne de 5 000 caractères au plus ; nombre : nombre JSON ; choix :
-- l'une des options ; case : booléen ; note d'état : un niveau de
-- `inspection_condition_levels()`.
CREATE FUNCTION inspection_values_error(p_fields jsonb, p_values jsonb, p_complete boolean)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_field jsonb;
  v_label text;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RETURN 'Les valeurs d''un état des lieux forment un objet, par identifiant de champ.';
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_values) LOOP
    v_field := NULL;
    SELECT f INTO v_field FROM jsonb_array_elements(p_fields) AS f WHERE f ->> 'id' = v_key;
    IF v_field IS NULL THEN
      RETURN format('Valeur pour un champ que le modèle ne connaît pas : « %s ».', v_key);
    END IF;
    CONTINUE WHEN jsonb_typeof(v_value) = 'null';
    v_label := v_field ->> 'label';

    CASE v_field ->> 'type'
      WHEN 'text' THEN
        IF jsonb_typeof(v_value) <> 'string' OR length(v_value #>> '{}') > 5000 THEN
          RETURN format('« %s » : un texte de 5 000 caractères au plus est attendu.', v_label);
        END IF;
      WHEN 'number' THEN
        IF jsonb_typeof(v_value) <> 'number' THEN
          RETURN format('« %s » : un nombre est attendu.', v_label);
        END IF;
      WHEN 'choice' THEN
        IF jsonb_typeof(v_value) <> 'string' OR NOT ((v_field -> 'options') ? (v_value #>> '{}')) THEN
          RETURN format('« %s » : choisissez l''une des options proposées.', v_label);
        END IF;
      WHEN 'checkbox' THEN
        IF jsonb_typeof(v_value) <> 'boolean' THEN
          RETURN format('« %s » : coché ou non coché.', v_label);
        END IF;
      WHEN 'condition' THEN
        IF jsonb_typeof(v_value) <> 'string'
           OR NOT ((v_value #>> '{}') = ANY (inspection_condition_levels())) THEN
          RETURN format('« %s » : une note d''état est attendue (neuf, bon, usage, mauvais).', v_label);
        END IF;
      ELSE
        RETURN format('« %s » : type de champ inconnu.', v_label);
    END CASE;
  END LOOP;

  IF p_complete THEN
    FOR v_field IN SELECT value FROM jsonb_array_elements(p_fields) LOOP
      CONTINUE WHEN NOT (v_field ->> 'required')::boolean;
      v_value := p_values -> (v_field ->> 'id');
      IF v_value IS NULL
         OR jsonb_typeof(v_value) = 'null'
         OR (jsonb_typeof(v_value) = 'string' AND btrim(v_value #>> '{}') = '') THEN
        RETURN format('« %s » est obligatoire : renseignez-le avant de clore.', v_field ->> 'label');
      END IF;
    END LOOP;
  END IF;

  RETURN NULL;
END
$$;
