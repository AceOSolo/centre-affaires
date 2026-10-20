# Envoyer les produits et les tarifs de Dolibarr au site

Pour le développeur Dolibarr. Le site est prêt : il n'y a **rien à coder**,
seulement une cible de webhook à déclarer et des références de produits à
respecter. Décision et raisons : [ADR 049](../decisions/049-produits-recus-de-dolibarr.md).
L'API des devis est décrite à part : [dolibarr.md](dolibarr.md).

## 1. Déclarer le webhook (10 minutes)

1. **Accueil → Configuration → Modules** : activer **Webhook**.
2. **Webhook → Cibles → Nouvelle cible** :

   | Champ | Valeur |
   |---|---|
   | Libellé | `Site Handfield — produits` |
   | URL | `https://www.handfield.fr/api/dolibarr/produits?jeton=<DOLIBARR_API_TOKEN>` |
   | Déclencheurs | `PRODUCT_CREATE,PRODUCT_MODIFY,PRODUCT_PRICE_MODIFY,PRODUCT_DELETE` |
   | Statut | Automatique |
   | Type | Non bloquant |

   Le jeton est celui de l'API des devis (`DOLIBARR_API_TOKEN`, dans le `.env`
   du serveur du site ; l'exploitant vous le remet). Le module ne sait pas
   poser d'en-tête : le jeton passe donc dans l'adresse. Un `+` du jeton peut
   être collé tel quel.
3. Conseillé : la constante `WEBHOOK_ENABLE_CALL_LOGS` à 1 (Configuration →
   Divers) pour garder la réponse du site à chaque envoi dans l'historique
   du module.

## 2. Nommer les produits

**La référence du produit décide de ce qu'il devient sur le site.** Majuscules
ou minuscules, peu importe ; pas d'espace ni d'accent.

### Services

Tout **service** (type « Service ») devient un service du catalogue du site,
dont le code est la référence. Ceux-ci sont **attendus par le site**, avec ces
références exactes :

| Référence | Ce que c'est |
|---|---|
| `courrier.ouverture` | Ouverture et numérisation d'un pli |
| `courrier.numerisation` | Numérisation d'un pli déjà ouvert, à la demande |
| `courrier.reexpedition` | Réexpédition d'un pli (affranchissement en sus) |
| `courrier.page` | Page numérisée au-delà de celles comprises dans l'ouverture |

Les autres services (forfaits, options…) prennent la référence de votre
choix : `domiciliation-premium`, `standard-telephonique`. Une **durée d'un
mois** sur la fiche en fait un forfait mensuel ; sans durée, c'est un acte
facturé à l'unité.

Les produits physiques (type « Produit ») sont ignorés.

### Tarifs des espaces

Le prix d'un espace à la réservation se nomme `tarif.<type>.<unité>` :

| Type | | Unité |
|---|---|---|
| `salle` | | `heure` |
| `bureau` | | `demi-journee` |
| `casier` | | `journee` |
| `vehicule` | | `semaine` |
| `boite_aux_lettres` | | `mois`, `unite` |

Ceux de la grille actuelle du site :

| Référence | Prix actuel du site (HT) |
|---|---|
| `tarif.salle.demi-journee` | 90 € |
| `tarif.salle.journee` | 130 € |
| `tarif.bureau.demi-journee` | 7 € |
| `tarif.boite_aux_lettres.mois` | 30 € |

Une ressource plus chère que son type se nomme
`tarif.<type>.<code de la ressource>.<unité>` — par exemple
`tarif.salle.sal-mb.heure` pour la salle Mont Blanc (codes visibles à l'écran
Ressources du site). Ce prix l'emporte sur celui du type.

## 3. Ce que le site reprend

| Dolibarr | Site |
|---|---|
| `label` | nom du service |
| `description` (HTML admis) | description, en texte simple |
| `price` (prix de vente HT de base) | prix unitaire HT |
| `tva_tx` | taux de TVA (services) |
| `status` « En vente » | service proposé ; hors vente : plus proposé, ou prix retiré de la grille |
| suppression du produit | service archivé, ou prix retiré de la grille |

Les niveaux de prix (multiprix) et les prix par client ne sont pas lus. Un
prix qui change n'écrase rien : l'ancien est gardé, retiré, pour expliquer
les montants déjà calculés.

## 4. Charger les produits existants

Le module n'envoie qu'à la création, la modification ou la suppression. Pour
les produits déjà saisis : ouvrir chaque fiche, **Modifier**, **Enregistrer**.
Même geste pour renvoyer un produit qu'un échec aurait laissé de côté
(Dolibarr ne réessaie pas).

## 5. Réponses du site

| Code | Sens |
|---|---|
| `200` `{"ok":true,"resultat":"cree"}` | pris en compte (`cree`, `modifie`, `retire`, `inchange`, ou `ignore` pour un produit sans place sur le site) |
| `422` `{"erreur":"…"}` | référence, prix ou TVA illisible : le message dit quoi corriger sur la fiche |
| `409` `{"erreur":"…"}` | le site n'a pas où poser le prix : aucune grille par défaut, ou code de ressource inconnu |
| `404` | jeton absent ou faux (la route n'existe pas pour les autres) |

Rejouer le même envoi ne change rien. Les deux déclencheurs que Dolibarr
envoie souvent ensemble (`PRODUCT_MODIFY` et `PRODUCT_PRICE_MODIFY`) ne
créent pas de doublon.

## 6. Essayer sans Dolibarr

```bash
curl -X POST "https://www.handfield.fr/api/dolibarr/produits?jeton=$DOLIBARR_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"triggercode":"PRODUCT_MODIFY","object":{"ref":"courrier.ouverture","label":"Ouverture et numérisation d’un pli","type":"1","price":"3.50000000","tva_tx":"20.000","status":"1"}}'
# {"ok":true,"resultat":"cree","message":"Service « courrier.ouverture » créé."}
```

Depuis la fiche cible, le bouton de test du module envoie un contenu de
démonstration : toute réponse autre que `404` prouve que l'adresse et le jeton
sont bons.
