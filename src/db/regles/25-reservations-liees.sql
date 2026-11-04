-- Matériel en option d'une réservation : les réservations liées (ADR 062).
--
-- Un appareil loué avec une salle est une réservation à part entière
-- (ressource de type `materiel`), liée à la réservation principale par
-- `bookings.parent_booking_id`. Le trigger anti-chevauchement le garde comme
-- toute réservation (décision 3) : un appareil n'est jamais loué deux fois.
-- Ce fichier tient ce qui en fait une option — SQLSTATE `CA018` :
--
-- - seule une ressource `materiel` se réserve en option, et une option est
--   une réservation (ni indisponibilité, ni occupation de contrat) ;
-- - la principale est une réservation, qui n'est ni du matériel ni elle-même
--   une option : un seul niveau ;
-- - une option ne change jamais de principale ;
-- - vivante, elle est au nom du client de la principale et tient dans sa
--   période ; elle ne se rattache pas à une principale annulée, ne se
--   confirme pas avant elle, et posée sur une demande en attente elle
--   l'attend (statut ramené à `pending`) ;
-- - la principale ne s'annule pas tant qu'une option vit.
--
-- La cascade elle-même (annuler, valider, déplacer les options avec la
-- principale) est faite par le code, dans la même transaction
-- (`src/modules/reservations/options-cascade.ts`) : MySQL interdit à un
-- trigger d'écrire dans la table qui le déclenche (erreur 1442). La base
-- garantit qu'elle n'est jamais oubliée.
--
-- Fichier idempotent, rejoué par `src/db/migrer.ts` dès que son contenu
-- change. Ses routines sont appelées par les triggers de `bookings`
-- (fichier 20) : MySQL les résout à l'exécution, l'ordre des fichiers
-- n'importe pas. Les messages tiennent en 128 caractères (MESSAGE_TEXT).

DROP PROCEDURE IF EXISTS booking_assert_option;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS booking_assert_no_live_option;
--> statement-breakpoint

-- Une option, à l'écriture. `p_status` : son statut, ramené à `pending` à
-- l'insertion quand la principale attend encore l'accueil.
CREATE PROCEDURE booking_assert_option(
  IN p_tenant CHAR(36),
  IN p_parent CHAR(36),
  IN p_kind VARCHAR(20),
  IN p_resource CHAR(36),
  IN p_client CHAR(36),
  IN p_starts DATETIME(3),
  IN p_ends DATETIME(3),
  INOUT p_status VARCHAR(20),
  IN p_inserting TINYINT
)
option_check: BEGIN
  DECLARE v_type VARCHAR(32);
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_grandparent CHAR(36);
  DECLARE v_client CHAR(36);
  DECLARE v_starts DATETIME(3);
  DECLARE v_ends DATETIME(3);
  DECLARE v_parent_type VARCHAR(32);

  SELECT MAX(resource_type) INTO v_type
    FROM resources
   WHERE tenant_id = p_tenant AND id = p_resource;
  IF v_type IS NOT NULL AND v_type <> 'materiel' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Seul du matériel se réserve en option d''une autre réservation.';
  END IF;
  IF p_kind <> 'booking' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Une option est une réservation, ni une indisponibilité ni une occupation de contrat.';
  END IF;

  SELECT COUNT(*), MAX(b.kind), MAX(b.status), MAX(b.parent_booking_id), MAX(b.client_id),
         MAX(b.starts_at), MAX(b.ends_at), MAX(r.resource_type)
    INTO v_found, v_kind, v_status, v_grandparent, v_client, v_starts, v_ends, v_parent_type
    FROM bookings AS b
    JOIN resources AS r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
   WHERE b.tenant_id = p_tenant AND b.id = p_parent;
  -- Principale introuvable : la clé étrangère le dira, avec son propre code.
  IF v_found = 0 THEN
    LEAVE option_check;
  END IF;

  IF v_grandparent IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Le matériel s''ajoute à la réservation principale, pas à une autre option.';
  END IF;
  IF v_kind <> 'booking' OR v_parent_type = 'materiel' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Le matériel s''ajoute à une réservation d''espace, ni à une occupation ni à un autre appareil.';
  END IF;

  -- Une option annulée est de l'historique : elle ne suit plus la principale.
  IF p_status = 'cancelled' THEN
    LEAVE option_check;
  END IF;
  IF v_status = 'cancelled' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: La réservation principale est annulée : on ne lui ajoute plus de matériel.';
  END IF;
  IF NOT (p_client <=> v_client) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Le matériel en option est au nom du client de la réservation principale.';
  END IF;
  IF p_starts < v_starts OR p_ends > v_ends THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Le matériel en option se réserve dans la période de la réservation principale.';
  END IF;
  IF v_status = 'pending' THEN
    IF p_inserting = 1 THEN
      SET p_status = 'pending';
    ELSEIF p_status = 'confirmed' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA018: Validez d''abord la réservation principale : son matériel la suit.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- Une principale qui s'annule : ses options doivent l'être d'abord, dans la
-- même transaction (`cancelOptionsInTransaction`).
CREATE PROCEDURE booking_assert_no_live_option(IN p_tenant CHAR(36), IN p_booking CHAR(36))
BEGIN
  IF EXISTS (
    SELECT 1 FROM bookings
     WHERE tenant_id = p_tenant AND parent_booking_id = p_booking AND status <> 'cancelled'
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA018: Annulez d''abord le matériel en option : il suit la réservation principale.';
  END IF;
END;
