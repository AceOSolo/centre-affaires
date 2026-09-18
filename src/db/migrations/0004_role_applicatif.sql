-- Les politiques de la migration 0003 ne s'appliquent pas au rôle propriétaire :
-- `neondb_owner` porte l'attribut BYPASSRLS sur Neon, `postgres` est
-- superutilisateur en local, et cet attribut l'emporte sur FORCE ROW LEVEL
-- SECURITY. Connectée avec lui, l'application ne rencontre jamais une politique
-- et l'isolation par centre de la décision 1 est décorative.
--
-- D'où un second rôle, réservé aux requêtes de l'application. Les migrations
-- continuent de passer par le propriétaire, et doivent le faire : la 0002
-- insère le premier centre dans `tenants`, dont la politique exige un
-- `app.tenant_id` qui n'existe pas encore à ce moment-là.
--
-- Le rôle est créé sans mot de passe. Celui-ci est posé par environnement par
-- `infra/provision-role-applicatif.mjs`, qui publie APP_DATABASE_URL, et ne
-- figure dans aucun fichier versionné. Voir ADR 003.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_centre') THEN
    CREATE ROLE app_centre LOGIN NOBYPASSRLS;
  END IF;
END
$$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_centre;

--> statement-breakpoint

-- Aucun DDL : le rôle applicatif lit et écrit des lignes, rien d'autre.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_centre;

--> statement-breakpoint

-- Les tables des tranches suivantes héritent des mêmes droits sans qu'il faille
-- y penser à chaque migration — à condition que les migrations restent jouées
-- par le propriétaire.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_centre',
    current_user
  );
END
$$;
