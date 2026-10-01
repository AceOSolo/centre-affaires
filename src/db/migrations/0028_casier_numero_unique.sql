-- R01 : deux casiers vivants d'un centre ne portent pas le même numéro, à la
-- casse près. L'index remplace la vérification faite en code dans la
-- transaction (`assertLockerNumberFree`), que deux saisies strictement
-- simultanées pouvaient passer. Un casier archivé rend son numéro.
--
-- Un doublon déjà en base ferait échouer la création de l'index sur un message
-- générique. Il est nommé d'abord, et la migration s'arrête sans rien changer :
-- c'est à l'équipe de renuméroter ou d'archiver l'un des casiers. Le
-- propriétaire porte BYPASSRLS (ADR 003) : la vérification voit tous les
-- centres.
DO $$
DECLARE
  doublons text;
BEGIN
  SELECT string_agg(format('n° %s (codes %s)', d.numero, d.codes), ' ; ')
    INTO doublons
    FROM (
      SELECT lower(r.attributes ->> 'numero') AS numero,
             string_agg(r.code, ', ' ORDER BY r.code) AS codes
        FROM resources AS r
       WHERE r.resource_type = 'casier'
         AND r.deleted_at IS NULL
         AND r.attributes ->> 'numero' IS NOT NULL
       GROUP BY r.tenant_id, lower(r.attributes ->> 'numero')
      HAVING count(*) > 1
    ) AS d;
  IF doublons IS NOT NULL THEN
    RAISE EXCEPTION 'Numéros de casier en double : %. Renumérotez ou archivez l''un des casiers, puis relancez la migration.', doublons;
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "resources_tenant_locker_numero_key" ON "resources" USING btree ("tenant_id",lower(attributes ->> 'numero')) WHERE resource_type = 'casier' and deleted_at is null;
