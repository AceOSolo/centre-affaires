-- Registre des consommations facturables transmises au CRM (ADR 066) :
-- `crm_consumptions`. Idempotent : rejoué par le migrateur dès que le fichier
-- change.
--
-- Le site ne facture rien (CLAUDE.md, Facturation) : une consommation est un
-- instantané de ce que le centre a fait, que le CRM vient chercher. Ce que la
-- base tient, quel que soit le chemin d'écriture — SQLSTATE `CA019` :
--
-- - une consommation naît prête, sans reprise par le CRM ni annulation ;
-- - son contenu ne se réécrit jamais : une source qui change l'annule et en
--   fait une autre (`crm/consommations.ts`) ;
-- - passages permis : prête → transmise | annulée ; transmise → annulée ;
--   l'annulation est définitive ;
-- - « transmise » exige l'identifiant du CRM, « annulée » un motif ; les
--   dates de chaque étape sont posées par la base ; une consommation annulée
--   après sa reprise garde la référence du CRM ;
-- - elle ne se supprime pas (décision 6).
--
-- Au plus une consommation vivante par source : index unique
-- `crm_consumptions_source_key`, dans la structure.

DROP TRIGGER IF EXISTS crm_consumptions_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS crm_consumptions_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS crm_consumptions_before_delete;
--> statement-breakpoint

CREATE TRIGGER crm_consumptions_before_insert
BEFORE INSERT ON crm_consumptions
FOR EACH ROW
BEGIN
  IF NEW.status <> 'ready'
     OR (NEW.crm_id IS NOT NULL) + (NEW.crm_ref IS NOT NULL) + (NEW.sent_at IS NOT NULL)
        + (NEW.cancelled_at IS NOT NULL) + (NEW.cancellation_reason IS NOT NULL) > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA019: Une consommation naît prête : la reprise par le CRM vient ensuite.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER crm_consumptions_before_update
BEFORE UPDATE ON crm_consumptions
FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.nature <=> OLD.nature
          AND NEW.source_id <=> OLD.source_id AND NEW.client_id <=> OLD.client_id
          AND NEW.occurred_at <=> OLD.occurred_at AND NEW.quantity <=> OLD.quantity
          AND NEW.unit <=> OLD.unit AND NEW.product_ref <=> OLD.product_ref
          AND NEW.description <=> OLD.description AND NEW.unit_price_cents <=> OLD.unit_price_cents
          AND NEW.discount_bp <=> OLD.discount_bp AND NEW.discount_amount_cents <=> OLD.discount_amount_cents
          AND NEW.vat_rate_bp <=> OLD.vat_rate_bp AND NEW.amount_cents <=> OLD.amount_cents
          AND NEW.fees_cents <=> OLD.fees_cents AND NEW.currency <=> OLD.currency
          AND NEW.details <=> OLD.details AND NEW.fingerprint <=> OLD.fingerprint
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA019: Une consommation ne se réécrit pas : une source qui change l''annule et en fait une autre.';
  END IF;

  IF NOT (NEW.status <=> OLD.status) THEN
    IF OLD.status = 'cancelled' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA019: Cette consommation est annulée : elle ne change plus d''état.';
    END IF;

    IF NEW.status = 'sent' THEN
      IF NEW.crm_id IS NULL OR TRIM(NEW.crm_id) = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA019: Une consommation transmise porte son identifiant dans le CRM.';
      END IF;
      SET NEW.sent_at = CURRENT_TIMESTAMP(3);
    ELSEIF NEW.status = 'cancelled' THEN
      IF NEW.cancellation_reason IS NULL OR TRIM(NEW.cancellation_reason) = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA019: Une consommation annulée dit pourquoi.';
      END IF;
      IF NOT (NEW.crm_id <=> OLD.crm_id AND NEW.crm_ref <=> OLD.crm_ref AND NEW.sent_at <=> OLD.sent_at) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA019: Une consommation annulée garde ce que le CRM en a repris.';
      END IF;
      SET NEW.cancelled_at = CURRENT_TIMESTAMP(3);
    ELSE
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA019: Une consommation reprise par le CRM ne redevient pas prête.';
    END IF;
  ELSEIF NOT (NEW.crm_id <=> OLD.crm_id AND NEW.crm_ref <=> OLD.crm_ref AND NEW.sent_at <=> OLD.sent_at
              AND NEW.cancelled_at <=> OLD.cancelled_at
              AND NEW.cancellation_reason <=> OLD.cancellation_reason) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA019: La reprise par le CRM et l''annulation ne se réécrivent pas.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER crm_consumptions_before_delete
BEFORE DELETE ON crm_consumptions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA019: Une consommation ne se supprime pas : elle s''annule (décision 6).';
END;
