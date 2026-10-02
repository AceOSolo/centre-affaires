-- Vague 2, monétisation (ADR 023, 026) : les deux règles d'arrondi de
-- l'argent, en base, avant les tables qui s'en servent dans des colonnes
-- générées (migration 0030).
--
-- Une seule règle par calcul, pour que le devis d'une réservation, la ligne
-- d'un contrat, la souscription et la ligne de facture tombent au même
-- centime. Le jumeau TypeScript est `src/modules/facturation/montants.ts`,
-- éprouvé contre ces fonctions (`montants.db.test.ts`).
--
-- IMMUTABLE : elles servent à des colonnes générées et à des contraintes.
-- Les changer demande de recalculer ces colonnes : un nouvel ADR, une
-- nouvelle fonction, une migration des colonnes.

-- Montant net HT d'une ligne, en centimes :
--
--   brut      = quantité × prix unitaire
--   remisé    = brut − remise en montant      (si `p_discount_cents`)
--             | brut × (10000 − remise) / 10000 (si `p_discount_bp`)
--   net       = remisé × prorata_numérateur / prorata_dénominateur
--
-- arrondi une seule fois, au centime le plus proche, la moitié s'éloignant de
-- zéro (`round(numeric)`). Une remise en montant est due par période entière,
-- comme le prix : une période partielle les proratise ensemble. Les deux
-- remises s'excluent (contraintes des tables). Sans prorata : 1/1.
--
-- Nul si la quantité ou le prix est nul : c'est ce qui laisse le devis
-- d'une réservation non chiffrée à nul.
CREATE FUNCTION line_net_amount_cents(
  p_quantity integer,
  p_unit_price_cents integer,
  p_discount_bp integer DEFAULT NULL,
  p_discount_cents integer DEFAULT NULL,
  p_prorata_numerator integer DEFAULT NULL,
  p_prorata_denominator integer DEFAULT NULL
) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(
    (p_quantity::numeric * p_unit_price_cents - coalesce(p_discount_cents, 0))
      * (10000 - coalesce(p_discount_bp, 0))
      * coalesce(p_prorata_numerator, 1)
      / (10000::numeric * coalesce(p_prorata_denominator, 1))
  )::integer
$$;

--> statement-breakpoint

-- TVA d'une base HT à un taux en points de base (2000 = 20 %), en centimes,
-- arrondie au centime le plus proche, la moitié s'éloignant de zéro.
--
-- EN 16931 (BR-CO-17) : la TVA se calcule par taux sur la somme des bases,
-- pas ligne à ligne. `invoice_refresh_amounts()` (migration 0031) l'applique
-- ainsi et répartit l'écart d'arrondi sur les lignes.
CREATE FUNCTION vat_amount_cents(p_base_cents bigint, p_rate_bp integer)
RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(p_base_cents::numeric * p_rate_bp / 10000)::bigint
$$;
