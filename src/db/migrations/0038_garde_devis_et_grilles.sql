-- Suites de la vague 2 (ADR 035) : ce que Drizzle ne sait pas décrire.
--
-- 1. Grilles par défaut successives (R08) : une seule grille par défaut un
--    jour donné, mais plusieurs dont les dates de validité se suivent — celle
--    de l'an prochain se prépare d'avance. L'index unique de la migration
--    d'origine (retiré par 0037) n'en permettait qu'une, toutes dates
--    confondues.
-- 2. Devis figé d'une réservation facturée (R11) : une fois qu'une ligne de
--    facture le reprend, il ne se réécrit plus (CA002), même hors de
--    l'application.

-- ---------------------------------------------------------------------------
-- 1. Une grille par défaut par jour
-- ---------------------------------------------------------------------------
-- Dates de validité nulles : sans borne de ce côté. Deux grilles par défaut
-- vivantes ne se recouvrent jamais ; une grille archivée ne compte plus.
ALTER TABLE rate_plans ADD CONSTRAINT rate_plans_default_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  daterange(valid_from, valid_to, '[]') WITH &&
) WHERE (is_default AND deleted_at IS NULL);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Le devis d'une réservation facturée ne change plus
-- ---------------------------------------------------------------------------
-- Tant qu'une ligne vivante d'une facture (émise ou brouillon, ni retirée ni
-- libérée par un avoir) tient la réservation, son devis (`quote_*`,
-- `quoted_at`) est celui que la facture a repris. Le déplacer ou en changer la
-- remise réécrirait un prix déjà facturé : refus CA002, comme une facture
-- émise. Pour corriger le prix : un avoir, puis la réservation se rechiffre.
-- Le reste de la réservation (heures, statut, notes) suit ses propres règles.
CREATE FUNCTION bookings_guard_invoiced_quote() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.quote_unit, NEW.quote_quantity, NEW.quote_unit_price_cents, NEW.quote_discount_bp,
      NEW.quote_discount_amount_cents, NEW.quote_vat_rate_bp, NEW.quote_currency,
      NEW.quote_rate_plan_item_id, NEW.quoted_at)
     IS NOT DISTINCT FROM
     (OLD.quote_unit, OLD.quote_quantity, OLD.quote_unit_price_cents, OLD.quote_discount_bp,
      OLD.quote_discount_amount_cents, OLD.quote_vat_rate_bp, OLD.quote_currency,
      OLD.quote_rate_plan_item_id, OLD.quoted_at) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoice_lines
     WHERE tenant_id = OLD.tenant_id AND booking_id = OLD.id
       AND deleted_at IS NULL AND released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Le prix de cette réservation est repris par une facture : il ne change plus. Pour le corriger, établissez d''abord un avoir.'
      USING ERRCODE = 'CA002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_guard_invoiced_quote
BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION bookings_guard_invoiced_quote();
