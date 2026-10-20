-- Devis transmis à Dolibarr (ADR 043) : `proposals` et `proposal_lines`.
-- Idempotent : rejoué par le migrateur dès que le fichier change.
--
-- Ce que la base tient, quel que soit le chemin d'écriture (page publique,
-- espace client, back-office, API Dolibarr) — SQLSTATE `CA016` :
--
-- - un devis naît brouillon, sans validation, référence Dolibarr ni issue ;
-- - il ne change jamais de numéro, de produit, de canal ni de réservation ;
-- - son contenu (destinataire, réponses, lignes) ne change qu'en brouillon :
--   ce que Dolibarr a repris est ce que le centre a validé ;
-- - passages permis : brouillon → prêt | annulé ; prêt → brouillon | transmis
--   | annulé ; transmis → signé | refusé | annulé ; les trois derniers sont
--   définitifs ;
-- - « prêt » exige au moins une ligne, « transmis » la référence Dolibarr ;
--   les dates de chaque étape sont posées par la base ;
-- - ne se supprime pas, une ligne non plus (`deleted_at`, décision 6) ;
-- - une réservation annulée annule son devis encore ouvert
--   (`bookings_cancel_proposal`).
--
-- Sous portée client (`@app_client_ids`, ADR 019), seul le dépôt d'un
-- brouillon de l'entreprise passe, avec ses lignes (`CA015`).

DROP TRIGGER IF EXISTS proposals_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposals_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposals_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_lines_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_lines_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_lines_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bookings_cancel_proposal;
--> statement-breakpoint

CREATE TRIGGER proposals_before_insert
BEFORE INSERT ON proposals
FOR EACH ROW
BEGIN
  IF NEW.status <> 'draft'
     OR (NEW.validated_at IS NOT NULL) + (NEW.validated_by_staff_id IS NOT NULL)
        + (NEW.dolibarr_id IS NOT NULL) + (NEW.dolibarr_ref IS NOT NULL) + (NEW.sent_at IS NOT NULL)
        + (NEW.outcome_at IS NOT NULL) + (NEW.cancelled_at IS NOT NULL) > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA016: Un devis naît brouillon : la validation et la reprise par Dolibarr viennent ensuite.';
  END IF;

  IF @app_client_ids IS NOT NULL
     AND (NEW.client_id IS NULL OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids) OR NEW.channel <> 'client') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : ce devis n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER proposals_before_update
BEFORE UPDATE ON proposals
FOR EACH ROW
BEGIN
  DECLARE v_lines int;

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.number <=> OLD.number
          AND NEW.product <=> OLD.product AND NEW.channel <=> OLD.channel
          AND NEW.booking_id <=> OLD.booking_id AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA016: Un devis ne change ni de numéro, ni de produit, ni de canal, ni de réservation.';
  END IF;

  -- L'effacement RGPD (ADR 040) vide le demandeur et les réponses, rien d'autre.
  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    -- Sous portée client, rien ne se modifie : le devis se traite au centre.
    -- Seule l'annulation qui suit celle de la réservation passe.
    IF @app_client_ids IS NOT NULL AND COALESCE(@app_proposal_sync, '') <> 'on' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA015: Un devis se traite au centre.';
    END IF;

    IF OLD.status <> 'draft'
       AND NOT (NEW.client_id <=> OLD.client_id AND NEW.requester_name <=> OLD.requester_name
                AND NEW.requester_email <=> OLD.requester_email AND NEW.requester_phone <=> OLD.requester_phone
                AND NEW.requester_company <=> OLD.requester_company AND NEW.answers <=> OLD.answers
                AND NEW.message <=> OLD.message AND NEW.staff_note <=> OLD.staff_note
                AND NEW.currency <=> OLD.currency) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA016: Ce devis est validé : remettez-le en brouillon pour le modifier.';
    END IF;

    IF NOT (NEW.status <=> OLD.status) THEN
      IF OLD.status IN ('accepted', 'refused', 'cancelled') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Ce devis est clos : il ne change plus d''état.';
      END IF;

      IF NEW.status = 'ready' THEN
        IF OLD.status <> 'draft' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Seul un brouillon se valide.';
        END IF;
        SELECT COUNT(*) INTO v_lines FROM proposal_lines
         WHERE tenant_id = NEW.tenant_id AND proposal_id = NEW.id AND deleted_at IS NULL;
        IF v_lines = 0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Un devis sans ligne ne se valide pas.';
        END IF;
        SET NEW.validated_at = CURRENT_TIMESTAMP(3);
      ELSEIF NEW.status = 'draft' THEN
        IF OLD.status <> 'ready' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA016: Un devis transmis à Dolibarr ne revient pas en brouillon : annulez-le et refaites-en un.';
        END IF;
        SET NEW.validated_at = NULL, NEW.validated_by_staff_id = NULL;
      ELSEIF NEW.status = 'sent' THEN
        IF OLD.status <> 'ready' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Seul un devis prêt se transmet à Dolibarr.';
        END IF;
        IF NEW.dolibarr_id IS NULL OR TRIM(NEW.dolibarr_id) = '' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Un devis transmis porte son identifiant Dolibarr.';
        END IF;
        SET NEW.sent_at = CURRENT_TIMESTAMP(3);
      ELSEIF NEW.status IN ('accepted', 'refused') THEN
        IF OLD.status <> 'sent' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Seul un devis transmis reçoit une issue.';
        END IF;
        SET NEW.outcome_at = CURRENT_TIMESTAMP(3);
      ELSEIF NEW.status = 'cancelled' THEN
        SET NEW.cancelled_at = CURRENT_TIMESTAMP(3);
      END IF;
    END IF;

    -- La référence Dolibarr se pose une fois, à la transmission.
    IF NOT (NEW.dolibarr_id <=> OLD.dolibarr_id AND NEW.dolibarr_ref <=> OLD.dolibarr_ref)
       AND NOT (OLD.status = 'ready' AND NEW.status = 'sent') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA016: La référence Dolibarr se pose à la transmission, puis ne change plus.';
    END IF;

    -- Les dates d'étape sont celles de la base.
    IF NEW.status <=> OLD.status
       AND NOT (NEW.validated_at <=> OLD.validated_at AND NEW.sent_at <=> OLD.sent_at
                AND NEW.outcome_at <=> OLD.outcome_at AND NEW.cancelled_at <=> OLD.cancelled_at) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Les dates d''un devis sont posées par la base.';
    END IF;
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER proposals_before_delete
BEFORE DELETE ON proposals
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA016: Un devis ne se supprime pas : annulez-le, il reste consultable.';
END;
--> statement-breakpoint

-- Une ligne ne s'écrit que sur un brouillon. Le verrou du devis sérialise
-- l'ajout d'une ligne et sa validation : une ligne ne se glisse pas dans un
-- devis que Dolibarr est en train de reprendre.
CREATE TRIGGER proposal_lines_before_insert
BEFORE INSERT ON proposal_lines
FOR EACH ROW
BEGIN
  DECLARE v_status varchar(16);
  DECLARE v_client char(36);

  SELECT status, client_id INTO v_status, v_client FROM proposals
   WHERE tenant_id = NEW.tenant_id AND id = NEW.proposal_id
   FOR UPDATE;
  IF v_status IS NULL OR v_status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA016: Ce devis est validé : remettez-le en brouillon pour changer ses lignes.';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Une ligne de devis naît vivante.';
  END IF;
  IF @app_client_ids IS NOT NULL AND (v_client IS NULL OR NOT FIND_IN_SET(v_client, @app_client_ids)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : ce devis n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER proposal_lines_before_update
BEFORE UPDATE ON proposal_lines
FOR EACH ROW
BEGIN
  DECLARE v_status varchar(16);

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.proposal_id <=> OLD.proposal_id
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Une ligne ne change pas de devis.';
  END IF;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA015: Un devis se traite au centre.';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA016: Une ligne retirée ne change plus.';
  END IF;
  SELECT status INTO v_status FROM proposals
   WHERE tenant_id = NEW.tenant_id AND id = NEW.proposal_id
   FOR UPDATE;
  IF v_status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA016: Ce devis est validé : remettez-le en brouillon pour changer ses lignes.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER proposal_lines_before_delete
BEFORE DELETE ON proposal_lines
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA016: Une ligne de devis ne se supprime pas : retirez-la (deleted_at).';
END;
--> statement-breakpoint

-- Une réservation annulée (refus de la demande, annulation par le client ou
-- par l'accueil) annule son devis encore ouvert, transmis compris : Dolibarr
-- le relit dans les devis annulés (`GET /api/dolibarr/devis?statut=cancelled`).
-- Un devis signé ou refusé reste tel quel : l'issue commerciale est acquise,
-- la suite se règle dans Dolibarr.
CREATE TRIGGER bookings_cancel_proposal
AFTER UPDATE ON bookings
FOR EACH ROW
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    SET @app_proposal_sync = 'on';
    UPDATE proposals
       SET status = 'cancelled',
           cancellation_reason = COALESCE(NEW.cancellation_reason, 'Réservation annulée.')
     WHERE tenant_id = NEW.tenant_id AND booking_id = NEW.id
       AND status IN ('draft', 'ready', 'sent');
    SET @app_proposal_sync = NULL;
  END IF;
END;
