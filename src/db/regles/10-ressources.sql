-- Règles du module ressources : resources, opening_hours, closures, listings.
--
-- Portées depuis les migrations PostgreSQL 0001-0004, 0010, 0011, 0014-0016,
-- 0028 et 0040. Presque tout ce que PostgreSQL tenait ici est désormais
-- exprimé par le schéma Drizzle (src/modules/ressources/schema.ts) :
--
-- - unicité du code d'une ressource vivante, du numéro d'un casier vivant, d'un
--   slug d'annonce vivante : index uniques sur colonnes générées
--   (`live`, `locker_numero_key`) ;
-- - unicité d'une plage horaire, y compris pour tout le centre (`resource_id`
--   nul) : colonne générée `resource_key` ;
-- - `CHECK` de `opening_hours` et `closures` ;
-- - `updated_at` et gardes de centre : triggers générés par le migrateur ;
-- - politiques RLS : supprimées (ADR 042). Les lectures filtrent sur
--   `tenant_id` dans le code ; ces quatre tables n'ont pas de portée client.
--
-- Il ne reste que la donnée de départ ci-dessous. Aucune routine n'est
-- appelée depuis le TypeScript (voir docs/migration-mysql/routines-ressources.md).

-- Horaires de départ : 9h-18h du lundi au vendredi, pour tout le centre.
--
-- Sans une ligne, aucune ressource ne serait ouverte : le planning serait vide
-- et le site public afficherait « fermé » partout. Les poser ici plutôt que de
-- prévoir un repli dans le code : un repli masquerait une configuration
-- oubliée, alors que ces lignes sont visibles et modifiables à l'écran.
--
-- Ce fichier se rejoue à chaque changement de règles : les horaires ne sont
-- donc posés que pour un centre qui n'en a aucun — jamais par-dessus une
-- configuration que l'équipe a faite (PostgreSQL ne les posait qu'une fois,
-- à la migration 0011).
INSERT INTO opening_hours (id, tenant_id, resource_id, weekday, opens_at, closes_at)
SELECT uuid(), t.id, NULL, d.weekday, '09:00:00', '18:00:00'
  FROM tenants AS t
 CROSS JOIN (
   SELECT 1 AS weekday UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
 ) AS d
 WHERE NOT EXISTS (SELECT 1 FROM opening_hours AS o WHERE o.tenant_id = t.id);
