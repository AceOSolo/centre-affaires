# Envoyer les produits et les tarifs de Dolibarr au site

Pour le développeur Dolibarr. Il n'y a **rien à coder** : une cible de
webhook à déclarer, et des références de produits à respecter. Décision et
raisons : [ADR 049](../decisions/049-produits-recus-de-dolibarr.md). L'API des
devis est décrite à part : [dolibarr.md](dolibarr.md).

> **Ne déclarez pas le webhook tant que l'adresse du site répond 404.**
> C'était le cas le 20 octobre 2026 : la version du site qui reçoit les
> produits n'était pas encore en production. Un webhook déclaré trop tôt fait
> échouer chaque enregistrement de produit dans Dolibarr (version 21 et
> avant, ou type « bloquant »), ou part dans le vide. Faites d'abord la
> vérification du § 6 : elle doit répondre `200`.

## Liste de vérification

1. **Version de Dolibarr** relevée (Accueil → Outils d'administration →
   Infos Dolibarr) : elle décide du type de cible et de l'endroit où lire les
   refus du site (§ 1).
2. **Le site répond** : la commande du § 6 rend `200` et `"resultat":"ignore"`,
   pas `404`.
3. **URL** : `https://www.handfield.fr/api/dolibarr/produits?jeton=…`, avec
   `www`.
4. **Jeton** : celui que l'exploitant vous remet, collé tel quel après
   `jeton=`.
5. **Références** conformes au § 2, en sachant que **tout service** dont la
   référence ne commence pas par `tarif.` entre au catalogue du site.
6. **Un produit d'essai** enregistré dans Dolibarr, et son résultat constaté
   (§ 5) : à l'écran Services ou Tarifs du site, dans l'historique des
   triggers (Dolibarr 23 et suivantes), ou dans le journal du site.
7. **Produits existants renvoyés** : chaque fiche ouverte, Modifier,
   Enregistrer (§ 4).

## 1. Déclarer le webhook

1. **Accueil → Configuration → Modules** : activer **Webhook**.
2. Configuration du module, onglet **Cibles**, nouvelle cible :

   | Champ | Valeur |
   |---|---|
   | Libellé | `Site Handfield — produits` |
   | URL | `https://www.handfield.fr/api/dolibarr/produits?jeton=<DOLIBARR_API_TOKEN>` |
   | Événements déclenchables | `PRODUCT_CREATE,PRODUCT_MODIFY,PRODUCT_PRICE_MODIFY,PRODUCT_DELETE` (sans espace : jusqu'à la 21, `PRODUCT_CREATE, PRODUCT_MODIFY` ne reconnaîtrait pas le second) |
   | Statut | Déclenchement automatique (valeur 1) |
   | Type | selon la version, ci-dessous (le champ n'existe qu'à partir de la 22) |

   Le jeton est celui de l'API des devis (`DOLIBARR_API_TOKEN`, dans le `.env`
   du serveur du site). Le module ne sait poser aucun en-tête : le jeton passe
   dans l'adresse ; un `+` peut être collé tel quel. L'adresse, jeton compris,
   se lit dans la fiche de la cible, dans les messages d'échec de Dolibarr,
   dans son historique des triggers et dans le journal d'accès du serveur du
   site.

### Ce que fait Dolibarr quand le site refuse

Vérifié dans le code du module (`interface_95_modWebhook_WebhookTriggers.class.php`,
branches 19.0 à 24.0 et `develop`) : toute réponse autre que `2xx` est un
échec.

| Version | Champ « Type » | Échec d'une cible bloquante | Le message du site |
|---|---|---|---|
| 21 et avant | absent : **toujours bloquant** | l'enregistrement du produit est **annulé** ; Dolibarr n'affiche que l'adresse et le code HTTP | jamais gardé |
| 22 | « Blocage » (par défaut) ou « Non bloquant » | comme en 21 | jamais gardé |
| 23 et 24 | « Transaction annuler en cas d'erreur » (par défaut, bloquant) ou « Aucun contrôle du résultat » (non bloquant) | comme en 21 | pour une réponse **400** seulement : ajouté au message d'échec, à l'écran (bloquant) et dans l'onglet **Historique des triggers**, tenu à chaque appel |
| suivante (`develop`) | comme en 23 | comme en 23 | comme en 23, mais l'historique n'est tenu que si la constante `WEBHOOK_ENABLE_CALL_LOGS` vaut 1 (Configuration → Divers) ; elle n'existe dans aucune version publiée |

Une cible **non bloquante** laisse enregistrer le produit quoi que réponde le
site ; l'échec ne va que dans le journal technique de Dolibarr et, à partir de
la 23, dans l'historique des triggers.

**Type conseillé**, à partir de la 22 : non bloquant (« Non bloquant », ou
« Aucun contrôle du résultat »), pour qu'une panne du site n'empêche pas de
travailler dans Dolibarr. En contrepartie, un refus passe inaperçu : regarder
l'historique des triggers après un enregistrement (23 et suivantes), ou
demander à l'exploitant le journal du site (§ 5). En **21 et avant**, pas de
choix : tout refus annule l'enregistrement du produit, et seul le journal du
site dit pourquoi.

Un refus du site se lit `httpcode=400 curl_error_no=` (rien après le `=`).
Un échec `httpcode=400 curl_error_no=1` vient de Dolibarr lui-même, sans
avoir appelé le site : à partir de la 22, il refuse les adresses qu'il juge
locales (Dolibarr sur le même serveur ou le même réseau que le site) ;
`$dolibarr_allow_localurl_for_webhooks` dans son `conf.php` le lève.

## 2. Nommer les produits

**La référence du produit décide de ce qu'il devient sur le site.** Majuscules
ou minuscules, peu importe ; pas d'espace ni d'accent.

| Référence | Type du produit | Sur le site |
|---|---|---|
| commence par `tarif.` | Service ou Produit | un prix de la grille tarifaire par défaut |
| toute autre | **Service** | un service du catalogue, de code égal à la référence |
| toute autre | Produit | ignoré |

### Services

**Tout service dont la référence ne commence pas par `tarif.` entre au
catalogue du site**, celui que les demandes de devis proposent — y compris un
service sans rapport avec le centre (frais internes, prestation d'une autre
activité). Rien ne permet aujourd'hui de l'écarter : en faire un « Produit »
(ignoré), ou le mettre hors vente (il entre au catalogue, mais n'est pas
proposé). Cette règle reste à confirmer avec l'exploitant.

La référence d'un service : 64 caractères au plus, lettres sans accent et
chiffres, les mots séparés par un seul `.`, `-` ou `_` — `courrier.ouverture`,
`domiciliation-premium`.

Ceux-ci sont **attendus par le site**, avec ces références exactes ; ils se
comptent toujours à l'acte, quelle que soit la fiche :

| Référence | Ce que c'est |
|---|---|
| `courrier.ouverture` | Ouverture et numérisation d'un pli |
| `courrier.numerisation` | Numérisation d'un pli déjà ouvert, à la demande |
| `courrier.reexpedition` | Réexpédition d'un pli (affranchissement en sus) |
| `courrier.page` | Page numérisée au-delà de celles comprises dans l'ouverture |

Les autres prennent la référence de votre choix. Une **durée en mois** sur la
fiche en fait un forfait mensuel ; sinon (sans durée, ou une durée en jours ou
en années), c'est un acte facturé à l'unité. Cette nature se fixe au premier
envoi et ne change plus.

### Tarifs des espaces

Le prix d'un espace à la réservation se nomme `tarif.<type>.<unité>` :

- types : `salle`, `bureau`, `casier`, `vehicule`, `boite_aux_lettres` ;
- unités : `heure`, `demi-journee`, `journee`, `semaine`, `mois`, `unite`.

Une ressource plus chère que son type se nomme
`tarif.<type>.<code de la ressource>.<unité>` — par exemple
`tarif.salle.sal-mb.heure` pour la salle Mont Blanc (codes visibles à l'écran
Ressources du site). Ce prix l'emporte sur celui du type.

Le prix va dans la grille tarifaire **par défaut** en vigueur le jour de
l'envoi ; sans elle, le site refuse (`400`) : la créer à l'écran Tarifs du
site, puis enregistrer à nouveau le produit. La TVA d'un tarif n'est pas lue.

Prix de départ du site (`infra/catalogue.mjs`), à reprendre ou corriger dans
Dolibarr :

| Référence | Prix (HT) |
|---|---|
| `tarif.salle.demi-journee` | 90 € |
| `tarif.salle.journee` | 130 € |
| `tarif.bureau.demi-journee` | 7 € |
| `tarif.boite_aux_lettres.mois` | 30 € |

### Changer une référence

Le module n'envoie pas l'ancienne référence d'un produit renommé : le site
créerait un second service, ou un second prix, et garderait l'ancien. Pour
changer de référence, créer le produit sous la nouvelle, puis mettre l'ancien
hors vente ou le supprimer : le site le retire de lui-même.

## 3. Ce que le site reprend

| Dolibarr | Site |
|---|---|
| `label` | nom du service |
| `description` (HTML admis) | description, en texte simple |
| `price` (prix de vente HT de base) | prix unitaire HT, ou prix de la grille |
| `tva_tx` | taux de TVA (services seulement) |
| `status` « En vente » | service proposé ; hors vente : plus proposé, ou prix retiré de la grille |
| suppression du produit | service archivé, ou prix retiré de la grille |

Les niveaux de prix (multiprix) et les prix par client ne sont pas lus. Un
prix qui change n'écrase rien : l'ancien est gardé, retiré, pour expliquer
les montants déjà calculés.

## 4. Charger les produits existants

Le module n'envoie qu'à la création, la modification ou la suppression. Pour
les produits déjà saisis : ouvrir chaque fiche, **Modifier**, **Enregistrer**.
Même geste pour renvoyer un produit qu'un échec aurait laissé de côté
(Dolibarr ne réessaie pas). En 21 et avant, un produit refusé n'est pas
enregistré dans Dolibarr non plus : corriger la fiche, puis enregistrer.

## 5. Réponses du site, et son journal

| Code | Sens |
|---|---|
| `200` `{"ok":true,"resultat":"cree"}` | pris en compte (`cree`, `modifie`, `retire`, `inchange`, ou `ignore` pour un produit sans place sur le site) |
| `400` `{"erreur":"…"}` | refusé, le message dit quoi corriger : référence, prix ou TVA illisible, référence de service trop longue, aucune grille tarifaire par défaut, code de ressource inconnu. Toujours `400`, le seul code dont Dolibarr garde le message |
| `404` | jeton absent ou faux, ou version du site qui n'a pas encore cette adresse |
| `500` `{"erreur":"…"}` | panne du site : enregistrer à nouveau plus tard |

Rejouer le même envoi ne change rien. Les deux déclencheurs que Dolibarr
envoie souvent ensemble (`PRODUCT_MODIFY` et `PRODUCT_PRICE_MODIFY`) ne
créent pas de doublon.

Chaque appel laisse une ligne dans le journal du site — déclencheur,
référence, code, issue, durée ; jamais le jeton ni le contenu du produit :

```
Webhook Dolibarr, produits : PRODUCT_MODIFY « tarif.salle.quinzaine » → 400 Unité « quinzaine » inconnue dans « tarif.salle.quinzaine » : … (4 ms)
```

L'exploitant la lit sur le serveur du site :
`docker compose logs app | grep "Webhook Dolibarr"`. Avant Dolibarr 23, c'est
le seul endroit où lire la raison d'un refus.

## 6. Vérifier que le site répond

Sans rien écrire : un produit physique est ignoré.

```bash
curl -sS -X POST "https://www.handfield.fr/api/dolibarr/produits?jeton=$DOLIBARR_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"triggercode":"PRODUCT_MODIFY","object":{"ref":"essai-webhook","type":"0"}}'
# {"ok":true,"resultat":"ignore","message":"« essai-webhook » est un produit physique : le site ne tient que les services."}
```

`Introuvable.` (`404`) : la version du site n'est pas encore déployée, ou le
jeton est faux. Ne pas déclarer le webhook dans ce cas.

Le bouton **Tester le WebHook** de la fiche de la cible envoie un contenu de
démonstration (le produit `PRODUCT_SPEC` ou `TEST_TRIGGER_CODE`), que le site
ignore : un succès prouve que l'adresse et le jeton sont bons, sans rien
écrire.
