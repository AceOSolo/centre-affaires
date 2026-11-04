-- Restitution des ressources (module `etats-des-lieux`, ADR 063).
--
-- Une ressource remise au client par un état des lieux d'entrée clos reste
-- occupée jusqu'à l'état des lieux de sortie qui clôt cette entrée, même
-- quand la réservation ou le contrat arrive à son terme sans lui (camion
-- rendu en retard, bureau non libéré). Passé la fin prévue sans sortie close,
-- la ressource est « non restituée » : le trigger anti-chevauchement des
-- réservations (`20-reservations.sql`, décision 3) refuse alors toute
-- écriture qui y prendrait du temps après cette fin prévue (`CA000`). La
-- sortie close lève le blocage.
--
-- Fichier idempotent, rejoué par `src/db/migrer.ts` dès que son contenu
-- change. Ses routines sont appelées par les triggers de `bookings` (fichier
-- 20) : MySQL les résout à l'exécution, l'ordre des fichiers n'importe pas.
-- Miroir TypeScript : `src/modules/etats-des-lieux/restitution.ts`, qui lit
-- la même fonction `inspection_unreturned_since()` pour l'affichage.

DROP PROCEDURE IF EXISTS booking_assert_resource_returned;
--> statement-breakpoint
DROP FUNCTION IF EXISTS inspection_unreturned_since;
--> statement-breakpoint
DROP FUNCTION IF EXISTS inspection_occupation_end;
--> statement-breakpoint

-- Fin prévue de l'occupation d'un état des lieux, ou NULL :
--
-- - réservation (hors occupation de contrat) : sa fin, sauf annulée ;
-- - contrat (pas de réservation, ou la réservation est l'occupation du
--   contrat, ADR 018) : la fin la plus tardive des occupations non annulées
--   du contrat sur la ressource ; NULL tant que le contrat n'a pas
--   d'occupation, et `booking_open_end()` pour un contrat sans terme.
CREATE FUNCTION inspection_occupation_end(p_tenant CHAR(36), p_inspection CHAR(36)) RETURNS DATETIME(3)
READS SQL DATA
BEGIN
  DECLARE v_resource CHAR(36);
  DECLARE v_booking CHAR(36);
  DECLARE v_contract CHAR(36);
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_end DATETIME(3);

  SELECT MAX(resource_id), MAX(booking_id), MAX(contract_id)
    INTO v_resource, v_booking, v_contract
    FROM inspections
   WHERE tenant_id = p_tenant AND id = p_inspection;

  IF v_booking IS NOT NULL THEN
    SELECT MAX(kind), MAX(status), MAX(ends_at) INTO v_kind, v_status, v_end
      FROM bookings
     WHERE tenant_id = p_tenant AND id = v_booking;
    IF v_kind <> 'contract' THEN
      IF v_status = 'cancelled' THEN
        RETURN NULL;
      END IF;
      RETURN v_end;
    END IF;
  END IF;

  IF v_contract IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT MAX(ends_at) INTO v_end
    FROM bookings
   WHERE tenant_id = p_tenant AND resource_id = v_resource AND contract_id = v_contract
     AND kind = 'contract' AND status <> 'cancelled';
  RETURN v_end;
END;
--> statement-breakpoint

-- Depuis quand la ressource d'un état des lieux d'entrée n'est pas
-- restituée : la fin prévue de son occupation, si l'entrée est close et
-- vivante, que cette fin est passée et qu'aucune sortie close ne la clôt.
-- NULL sinon — occupation en cours, restituée, annulée, ou entrée en saisie.
CREATE FUNCTION inspection_unreturned_since(p_tenant CHAR(36), p_entry CHAR(36)) RETURNS DATETIME(3)
READS SQL DATA
BEGIN
  DECLARE v_open INT DEFAULT 0;
  DECLARE v_returned INT DEFAULT 0;
  DECLARE v_end DATETIME(3);

  SELECT COUNT(*) INTO v_open
    FROM inspections
   WHERE tenant_id = p_tenant AND id = p_entry
     AND kind = 'entry' AND status = 'closed' AND deleted_at IS NULL;
  IF v_open = 0 THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO v_returned
    FROM inspections
   WHERE tenant_id = p_tenant AND entry_inspection_id = p_entry
     AND kind = 'exit' AND status = 'closed' AND deleted_at IS NULL;
  IF v_returned > 0 THEN
    RETURN NULL;
  END IF;

  SET v_end = inspection_occupation_end(p_tenant, p_entry);
  -- Bornes `[)` : une réservation qui finit à 10 h est échue à 10 h.
  IF v_end IS NULL OR v_end > CURRENT_TIMESTAMP(3) THEN
    RETURN NULL;
  END IF;
  RETURN v_end;
END;
--> statement-breakpoint

-- Garde appelée par les triggers de `bookings`, après le contrôle de
-- chevauchement et sous le même verrou de la ressource : refuse (`CA000`) une
-- réservation de la ressource qui finirait après la fin prévue d'une
-- occupation non restituée. L'occupation elle-même n'est pas visée : la
-- prolonger pour régulariser reste possible, sous le contrôle de
-- chevauchement ordinaire.
--
-- `CA000`, le code du créneau occupé : tous les chemins d'écriture (back-
-- office, espace client, page publique, contrats, avenants, saisie en masse)
-- le savent déjà traduire. Le message dit la cause à l'équipe.
CREATE PROCEDURE booking_assert_resource_returned(
  IN p_tenant CHAR(36),
  IN p_resource CHAR(36),
  IN p_booking CHAR(36),
  IN p_kind VARCHAR(20),
  IN p_contract CHAR(36),
  IN p_ends DATETIME(3)
)
BEGIN
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_name TEXT;
  DECLARE v_message VARCHAR(128);

  SELECT COUNT(*) INTO v_count
    FROM inspections AS e
   WHERE e.tenant_id = p_tenant AND e.resource_id = p_resource
     AND e.kind = 'entry' AND e.status = 'closed' AND e.deleted_at IS NULL
     -- L'occupation elle-même : sa réservation, ou une occupation du même contrat.
     AND NOT (e.booking_id <=> p_booking)
     AND NOT (p_kind = 'contract' AND e.contract_id <=> p_contract)
     -- Les entrées déjà closes par leur sortie, d'abord écartées par l'index
     -- (`inspections_exit_per_entry_key`) : la fonction ne lit que les autres.
     AND NOT EXISTS (
       SELECT 1 FROM inspections AS x
        WHERE x.tenant_id = e.tenant_id AND x.entry_inspection_id = e.id
          AND x.status = 'closed' AND x.deleted_at IS NULL)
     AND p_ends > inspection_unreturned_since(p_tenant, e.id);

  IF v_count > 0 THEN
    SELECT MAX(name) INTO v_name FROM resources WHERE tenant_id = p_tenant AND id = p_resource;
    SET v_message = CONCAT('CA000: Ressource non restituée : « ', LEFT(COALESCE(v_name, ''), 40),
      ' » attend son état des lieux de sortie.');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
END;
