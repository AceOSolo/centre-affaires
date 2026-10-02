# ADR 035 — Suites de la vague 2 : grilles par défaut successives, devis d'une réservation facturée, et manques de schéma écartés

**Date** : 2026-10-02
**Statut** : accepté — amende l'ADR 023 (une grille par défaut par jour, et
non plus une seule) ; les choix marqués « à valider » attendent le centre

## Contexte

L'intégration de la vague 2 a relevé vingt-trois manques de schéma
(`docs/roadmap.md`). Les ADR 032 à 034 en ont levé huit. Cet ADR tranche le
reste : ce qui se construit maintenant, et ce qui est écarté, avec la raison.

## Décision

### Grilles par défaut successives (R08)

Une seule grille par défaut **un jour donné**, et non plus une seule tout
court. La contrainte d'exclusion `rate_plans_default_no_overlap` (migration
0038) refuse deux grilles par défaut vivantes dont les dates de validité se
recouvrent ; l'index unique d'origine (retiré par 0037) en refusait deux
quelles que soient leurs dates. La grille de l'an prochain se prépare donc
d'avance, avec ses dates : le devis d'une réservation (`quote`) et la page
publique (`findDefaultRatePlan`) prennent celle qui est en vigueur le jour du
créneau (`defaultRatePlanOn`). L'écran des grilles signale un jour sans grille
par défaut en vigueur ; le message d'un recouvrement dit de régler les dates.

### Le devis d'une réservation facturée ne se réécrit plus (R11)

Tant qu'une ligne vivante d'une facture tient une réservation, son devis
(`quote_*`, `quoted_at`) ne change plus (`bookings_guard_invoiced_quote`,
CA002). L'application ne le faisait déjà pas (une réservation facturée et
déplacée garde son prix) ; la base le garantit désormais pour tout chemin
d'écriture, comme pour une facture émise. Pour corriger : un avoir, ou la
ligne retirée du brouillon.

### Souscriptions d'un contrat brouillon : un état dérivé, pas une colonne

Une souscription rattachée à un contrat brouillon attend son activation ; à
un contrat archivé, elle ne se facture plus. Le lot les ignorait déjà
(ADR 028) ; la fiche du client les montrait « En cours ». Elle dit désormais
« En attente du contrat » (facturée à l'activation) ou « Contrat archivé »
(`subscriptionHold`), sans colonne nouvelle : l'état se déduit du contrat, et
une colonne pourrait le contredire.

### Manques de schéma : ce qui est fait, ce qui est écarté

| Manque relevé à l'intégration | Sort |
|---|---|
| Une seule grille par défaut à la fois | **Fait** (ci-dessus) |
| Pas de taux de TVA par ligne de grille (`rate_plan_items.vat_rate_bp`) | Écarté : salles, bureaux et véhicules sont au taux du centre (20 %, ADR 029) ; à ajouter quand un tarif à un autre taux existera |
| Pas de réglage de l'unité retenue pour une réservation | Écarté : la règle « la moins chère, la plus grande à égalité » est celle de l'ADR 023, à valider ; un réglage sans demande ajouterait un écran |
| Devis d'une réservation facturée réécrivable | **Fait** (ci-dessus) |
| Pas de période de facturation sur `subscribed_services` | Écarté : les actes inclus s'entendent par mois, comme les offres de domiciliation les vendent (ADR 024) ; à reprendre si une offre vend un quota trimestriel |
| Pas d'état « en attente » des souscriptions | **Fait** sans colonne (ci-dessus) |
| Pas de lien vers la souscription remplacée | Écarté : la chaîne client, service, contrat est sans ambiguïté, `subscribed_services_no_overlap` interdisant le recouvrement (le lot s'en sert, ADR 032) |
| Un service à l'acte peut se recouvrir entre deux contrats | Écarté : `priceActs` retient la plus avantageuse pour le client (ADR 024) |
| `offer_items` sans désignation ; unité ambiguë des inclus | Écarté pour la vague 3 : à trancher avec l'offre groupée du portail (R23) |
| `contracts.resource_id` unique : une offre à plusieurs ressources n'en occupe qu'une | Écarté : un contrat par ressource en attendant ; l'occupation par segments (ADR 025) devrait devenir multi-ressource, un nouvel ADR si le centre vend de telles offres |
| Client d'un brouillon de contrat figé dès qu'il porte une souscription | Écarté : cas rare ; annuler la souscription, changer de client, souscrire à nouveau |
| Montant d'une version non remis à zéro au retrait de sa dernière ligne récurrente | Écarté (ADR 032) |
| Loyer global refusé à côté de lignes ponctuelles | Fait (ADR 032) |
| Reconduction tacite sans tâche ni journal | Fait (ADR 033) |
| Pas de document signé ni d'état « remis / signé » | Écarté : la signature reste manuelle (ADR 028) ; stocker le scan signé suivra le stockage documentaire chiffré des états des lieux (vague 4, R33) |
| Pas de date « facturé jusqu'au » pour les contrats repris | Écarté : le lot ne rattrape rien (ADR 029), un contrat repris est facturé à partir du premier lot ; `contract_billed_through` (ADR 032) la donne ensuite |
| `invoice_runs.created_by` obligatoire | Fait (ADR 033) |
| `vat_exemption_reason` ni exigé ni vérifié | Fait (ADR 032) |
| `InvoiceRunResult` incomplet | Fait (ADR 032) |
| Pas de journal des relances | Fait (ADR 034) |
| Pas de table des remises de prélèvement | Écarté (ADR 034) |
| Pas de marque « prélevée » ni « envoyée à la plateforme » ; fichier d'export comptable non stocké | Écarté : un prélèvement se lit dans les paiements (`direct_debit`) ; la marque « envoyée » attend la plateforme (R16) ; l'export se reconstruit et se vérifie par son empreinte (ADR 030) |
| Pas de mode de paiement préféré sur `clients` | Écarté : le mode suit le mandat (`expectedPaymentFor`, ADR 027 et 030) ; une préférence le contredirait |
| `invoice_lines.resource_id` et `service_id` non posés par la base | Écarté : le lot et la saisie les posent ; les indicateurs se replient sur la source (ADR 031) |

## Justification

**Une grille par jour, pas par centre.** Le prix d'un jour doit être
déterminé ; c'est la seule raison de l'index d'origine. La contrainte
d'exclusion garde cette garantie sans empêcher de préparer une hausse de
tarifs, ce que demandaient les dates de validité de R08.

**Garantir en base ce que l'application fait déjà.** Un prix repris par une
facture est un engagement ; le réécrire hors de l'application (import,
correction en SQL, code à venir) recréerait l'écart que la décision 6 et
l'ADR 026 interdisent pour la facture elle-même.

**Écarter plutôt que construire par précaution.** Chaque table ou colonne
écartée ci-dessus a un chemin existant qui couvre le besoin, ou attend une
décision qui n'appartient pas au code (plateforme, offres multi-ressources).

## Alternatives écartées

**Une seule grille par défaut, changée à la main le 1er janvier** : une
réservation prise en décembre pour janvier serait chiffrée à l'ancien tarif,
et l'oubli du changement passerait inaperçu.

**Une colonne `pending` sur les souscriptions** : elle dupliquerait l'état du
contrat et pourrait le contredire après une activation.

## Conséquences

- Migrations 0037 (retrait de l'index) et 0038 (contrainte d'exclusion, garde
  du devis).
- L'ADR 023 ne dit plus vrai sur « une seule grille par défaut à la fois ».
- **À valider par le centre** : préparer les grilles de l'année suivante avec
  leurs dates ; le sort des manques écartés ci-dessus.
