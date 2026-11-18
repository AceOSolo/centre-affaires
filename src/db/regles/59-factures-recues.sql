-- Factures reçues du CRM (ADR 081) : `crm_invoices`. Idempotent : rejoué par
-- le migrateur dès que le fichier change.
--
-- Le site ne facture rien (CLAUDE.md, Facturation) : une facture reçue est la
-- copie de lecture de ce que le CRM a émis, que l'espace client montre. Le
-- CRM la modifie à chaque envoi (état, reste à payer, lien du PDF). Ce que la
-- base tient, quel que soit le chemin d'écriture — SQLSTATE `CA027` :
--
-- - une facture reçue garde le CRM et l'identifiant qui la désignent : une
--   autre facture du CRM est une autre ligne ;
-- - elle naît visible : une facture retirée l'est par un envoi qui la retire ;
-- - elle ne se supprime pas (décision 6) : supprimée dans le CRM, elle est
--   retirée de l'espace client (`removed_at`), la ligne reste.
--
-- Une facture du CRM n'est qu'une ligne : index unique
-- `crm_invoices_external_key`, dans la structure.

DROP TRIGGER IF EXISTS crm_invoices_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS crm_invoices_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS crm_invoices_before_delete;
--> statement-breakpoint

CREATE TRIGGER crm_invoices_before_insert
BEFORE INSERT ON crm_invoices
FOR EACH ROW
BEGIN
  IF NEW.removed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA027: Une facture reçue naît visible : elle se retire ensuite, par un envoi du CRM.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER crm_invoices_before_update
BEFORE UPDATE ON crm_invoices
FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.connector <=> OLD.connector
          AND NEW.external_id <=> OLD.external_id AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA027: Une facture reçue garde le CRM et l''identifiant qui la désignent.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER crm_invoices_before_delete
BEFORE DELETE ON crm_invoices
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA027: Une facture reçue ne se supprime pas : elle se retire de l''espace client (décision 6).';
END;
