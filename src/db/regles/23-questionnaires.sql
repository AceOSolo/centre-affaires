-- Formulaires de demande réglés par le centre (ADR 074) : `questionnaires`,
-- et les réponses en clair figées sur le devis (`proposals.described_answers`).
-- Idempotent : rejoué par le migrateur dès que le fichier change.
--
-- Ce que la base tient, quel que soit le chemin d'écriture — SQLSTATE `CA020` :
--
-- - les questions d'un formulaire ont la forme que le code relit : une liste
--   d'au plus 40 questions, chacune nommée (lettres et chiffres), avec un
--   libellé et un type connu ; des choix aux valeurs simples ; une condition
--   qui nomme une question et ses réponses. Le code vérifie le reste
--   (`questionnaireProblem`) : noms uniques, condition posée avant, etc. ;
-- - les services proposés en option sont une liste de codes du catalogue ;
-- - les réponses en clair d'un devis sont celles que le demandeur a lues :
--   elles s'écrivent à la création et ne changent qu'en brouillon, jamais sous
--   la portée d'un client (ADR 019). L'effacement RGPD (`@app_anonymization`,
--   ADR 040) passe.
--
-- Un second trigger `BEFORE UPDATE` sur `proposals`, à côté de celui de
-- `52-devis.sql` (`CA016`) que ce fichier ne touche pas.

DROP TRIGGER IF EXISTS questionnaires_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS questionnaires_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS proposals_described_answers_frozen;
--> statement-breakpoint

CREATE TRIGGER questionnaires_before_insert
BEFORE INSERT ON questionnaires
FOR EACH ROW
BEGIN
  IF NOT JSON_SCHEMA_VALID('{
        "type": "array",
        "maxItems": 40,
        "items": {
          "type": "object",
          "required": ["name", "label", "kind"],
          "properties": {
            "name": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]{0,39}$" },
            "label": { "type": "string", "minLength": 1, "maxLength": 200 },
            "kind": { "enum": ["integer", "text", "textarea", "choice", "multi", "yesno", "date", "siret"] },
            "required": { "type": "boolean" },
            "hidden": { "type": "boolean" },
            "allowOther": { "type": "boolean" },
            "notBeforeToday": { "type": "boolean" },
            "hint": { "type": "string", "maxLength": 300 },
            "min": { "type": "integer" },
            "max": { "type": "integer" },
            "maxLength": { "type": "integer", "minimum": 1, "maximum": 2000 },
            "choices": {
              "type": "array",
              "maxItems": 30,
              "items": {
                "type": "object",
                "required": ["value", "label"],
                "properties": {
                  "value": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": 40 },
                  "label": { "type": "string", "minLength": 1, "maxLength": 120 }
                }
              }
            },
            "showWhen": {
              "type": "object",
              "required": ["question", "values"],
              "properties": {
                "question": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]{0,39}$" },
                "values": { "type": "array", "minItems": 1, "items": { "type": "string" } }
              }
            }
          }
        }
      }', NEW.questions) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA020: Ces questions n''ont pas la forme d''un formulaire de demande.';
  END IF;
  IF NOT JSON_SCHEMA_VALID('{
        "type": "array",
        "maxItems": 50,
        "items": { "type": "string", "pattern": "^[a-z0-9]+([._-][a-z0-9]+)*$" }
      }', NEW.service_codes) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA020: Les options proposées sont des codes de services du catalogue.';
  END IF;
END;
--> statement-breakpoint

-- Même contrôle à la modification : le corps est celui de l'insertion.
CREATE TRIGGER questionnaires_before_update
BEFORE UPDATE ON questionnaires
FOR EACH ROW
BEGIN
  IF NOT (NEW.form <=> OLD.form) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA020: Un réglage de formulaire ne change pas de formulaire.';
  END IF;
  IF NOT JSON_SCHEMA_VALID('{
        "type": "array",
        "maxItems": 40,
        "items": {
          "type": "object",
          "required": ["name", "label", "kind"],
          "properties": {
            "name": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]{0,39}$" },
            "label": { "type": "string", "minLength": 1, "maxLength": 200 },
            "kind": { "enum": ["integer", "text", "textarea", "choice", "multi", "yesno", "date", "siret"] },
            "required": { "type": "boolean" },
            "hidden": { "type": "boolean" },
            "allowOther": { "type": "boolean" },
            "notBeforeToday": { "type": "boolean" },
            "hint": { "type": "string", "maxLength": 300 },
            "min": { "type": "integer" },
            "max": { "type": "integer" },
            "maxLength": { "type": "integer", "minimum": 1, "maximum": 2000 },
            "choices": {
              "type": "array",
              "maxItems": 30,
              "items": {
                "type": "object",
                "required": ["value", "label"],
                "properties": {
                  "value": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": 40 },
                  "label": { "type": "string", "minLength": 1, "maxLength": 120 }
                }
              }
            },
            "showWhen": {
              "type": "object",
              "required": ["question", "values"],
              "properties": {
                "question": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]{0,39}$" },
                "values": { "type": "array", "minItems": 1, "items": { "type": "string" } }
              }
            }
          }
        }
      }', NEW.questions) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA020: Ces questions n''ont pas la forme d''un formulaire de demande.';
  END IF;
  IF NOT JSON_SCHEMA_VALID('{
        "type": "array",
        "maxItems": 50,
        "items": { "type": "string", "pattern": "^[a-z0-9]+([._-][a-z0-9]+)*$" }
      }', NEW.service_codes) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA020: Les options proposées sont des codes de services du catalogue.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER proposals_described_answers_frozen
BEFORE UPDATE ON proposals
FOR EACH ROW
BEGIN
  IF NOT (NEW.described_answers <=> OLD.described_answers)
     AND COALESCE(@app_anonymization, '') <> 'on' THEN
    IF @app_client_ids IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA020: Les réponses d''un devis se corrigent au centre.';
    END IF;
    IF OLD.status <> 'draft' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA020: Ce devis est validé : les réponses lues par le demandeur ne changent plus.';
    END IF;
  END IF;
END;
