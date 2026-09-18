-- Contraintes que Drizzle ne sait pas décrire, et création du centre unique.

-- Centre unique tant que le produit est mono-centre. Cet identifiant est la
-- valeur de repli de `tenant_id_default()` (migration 0000) et de
-- DEFAULT_TENANT_ID dans src/db/tenants.ts.
INSERT INTO tenants (id, name, slug)
VALUES ('01999f00-0000-7000-8000-000000000001', 'Centre principal', 'centre-principal')
ON CONFLICT (id) DO NOTHING;

--> statement-breakpoint

-- Anti-double-réservation au niveau base (décision 3). Rend le chevauchement
-- impossible quelles que soient les erreurs applicatives ou la concurrence ;
-- ne jamais le remplacer par une vérification en code.
-- Bornes `[)` : une réservation qui finit à 10h00 et une qui commence à 10h00
-- ne se chevauchent pas.
ALTER TABLE bookings
ADD CONSTRAINT bookings_no_overlap
EXCLUDE USING gist (
  resource_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status <> 'cancelled');

--> statement-breakpoint

CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER resources_set_updated_at
BEFORE UPDATE ON resources
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER bookings_set_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
