-- Modification et annulation d'une réservation par son client (ADR 076,
-- recette du 17/11/2026) — SQLSTATE `CA022`.
--
-- Depuis son espace, une personne de l'entreprise modifie (dates, heures,
-- formule) ou annule une demande **ou une réservation confirmée**, jusqu'à
-- N jours avant son début : N est réglé par le centre
-- (`tenants.booking_change_days`, 7 par défaut), le délai se compte en heure
-- murale du centre (une réservation du lundi 9 h, à sept jours, se modifie
-- jusqu'au lundi précédent 9 h, changement d'heure compris).
--
-- Ce fichier tient :
--
-- - `booking_client_change_deadline()` : l'instant, exclu, où le délai se
--   ferme. Jumeau de `clientChangeDeadline` (`compte-regles.ts`) ;
-- - `booking_assert_client_change()` : la règle, appelée par
--   `bookings_before_update` (fichier 20) dès qu'une annulation porte une
--   personne de l'entreprise, et pour toute modification sous portée client :
--   ni annulée ni commencée, avant le délai, et sans matériel en option pour
--   une modification (il faudrait le déplacer avec elle : l'accueil s'en
--   charge) ;
-- - `bookings_client_change_proposal` : une réservation que son client
--   modifie annule son devis encore ouvert, comme une réservation annulée
--   (`bookings_cancel_proposal`, fichier 52) ; le code en dépose aussitôt un
--   nouveau, aux nouvelles dates, dans la même transaction.
--
-- Une modification repasse toujours la réservation en attente : l'accueil la
-- valide de nouveau. Le chevauchement reste gardé par le trigger de la
-- décision 3 (`CA000`), qui la relit puisqu'elle bouge.
--
-- Idempotent, rejoué par `src/db/migrer.ts` dès que son contenu change. Les
-- routines sont résolues à l'exécution : l'ordre des fichiers n'importe pas.
-- Les messages tiennent en 128 caractères (MESSAGE_TEXT).

DROP TRIGGER IF EXISTS bookings_client_change_proposal;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS booking_assert_client_change;
--> statement-breakpoint
DROP FUNCTION IF EXISTS booking_client_change_deadline;
--> statement-breakpoint

-- Fin du délai de modification d'une réservation qui commence à `p_starts` :
-- le même instant d'heure murale, `booking_change_days` jours plus tôt.
-- Les fuseaux de MySQL doivent être chargés (`mysql_tzinfo_to_sql`), comme
-- pour la numérotation et l'occupation des contrats.
CREATE FUNCTION booking_client_change_deadline(p_tenant CHAR(36), p_starts DATETIME(3))
RETURNS DATETIME(3)
READS SQL DATA
BEGIN
  DECLARE v_days INT;
  DECLARE v_time_zone VARCHAR(64);
  DECLARE v_local DATETIME(3);

  SELECT MAX(booking_change_days), MAX(timezone) INTO v_days, v_time_zone
    FROM tenants
   WHERE id = p_tenant;
  IF v_time_zone IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA022: Centre introuvable : le délai de modification ne se calcule pas.';
  END IF;
  SET v_local = CONVERT_TZ(p_starts, '+00:00', v_time_zone);
  IF v_local IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'Fuseaux horaires MySQL non chargés (mysql_tzinfo_to_sql) : délai de modification non calculé.';
  END IF;
  RETURN CONVERT_TZ(DATE_SUB(v_local, INTERVAL COALESCE(v_days, 7) DAY), v_time_zone, '+00:00');
END;
--> statement-breakpoint

-- La règle d'une annulation (`p_new_status = 'cancelled'`) ou d'une
-- modification par le client, lue sur la ligne d'avant (`p_old_*`).
CREATE PROCEDURE booking_assert_client_change(
  IN p_tenant CHAR(36),
  IN p_booking CHAR(36),
  IN p_old_status VARCHAR(20),
  IN p_new_status VARCHAR(20),
  IN p_old_starts DATETIME(3)
)
BEGIN
  IF p_old_status NOT IN ('pending', 'confirmed') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA022: Cette réservation est déjà annulée : elle ne se modifie plus.';
  END IF;
  IF p_old_starts <= CURRENT_TIMESTAMP(3) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA022: Cette réservation a commencé : pour la modifier ou l''annuler, contactez l''accueil.';
  END IF;
  IF CURRENT_TIMESTAMP(3) >= booking_client_change_deadline(p_tenant, p_old_starts) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA022: Le délai pour modifier ou annuler depuis l''espace client est passé : contactez l''accueil.';
  END IF;
  IF p_new_status <> 'cancelled' THEN
    IF p_new_status <> 'pending' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA022: Une réservation modifiée par son client attend de nouveau la validation de l''accueil.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM bookings
       WHERE tenant_id = p_tenant AND parent_booking_id = p_booking AND status <> 'cancelled'
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA022: Cette réservation emporte du matériel en option : pour la modifier, contactez l''accueil.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- Réservation modifiée depuis l'espace client (portée client, toujours
-- repassée en attente, période ou prix changés) : son devis encore ouvert est
-- annulé — Dolibarr le relit dans les devis annulés — et le code en dépose un
-- nouveau dans la même transaction.
CREATE TRIGGER bookings_client_change_proposal
AFTER UPDATE ON bookings
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL
     AND NEW.status = 'pending'
     AND NOT (NEW.starts_at <=> OLD.starts_at AND NEW.ends_at <=> OLD.ends_at
              AND NEW.quote_unit <=> OLD.quote_unit AND NEW.quote_quantity <=> OLD.quote_quantity
              AND NEW.quote_unit_price_cents <=> OLD.quote_unit_price_cents
              AND NEW.quoted_at <=> OLD.quoted_at) THEN
    SET @app_proposal_sync = 'on';
    UPDATE proposals
       SET status = 'cancelled',
           cancellation_reason = 'Réservation modifiée par le client : un nouveau devis la remplace.'
     WHERE tenant_id = NEW.tenant_id AND booking_id = NEW.id
       AND status IN ('draft', 'ready', 'sent');
    SET @app_proposal_sync = NULL;
  END IF;
END;
