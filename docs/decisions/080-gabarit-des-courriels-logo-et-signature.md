# ADR 080 — Gabarit des courriels : logo, signature, version HTML

**Date** : 2026-11-17
**Statut** : accepté — recette du 17/11/2026, lot 7 ; complète les ADR 038
et 059 ; une migration (`tenants.email_logo`, `tenants.email_signature`)

## Contexte

« Améliorer l'allure des courriels reçus, avec une signature propre et le
logo. » Tous les courriels partaient en texte brut (`sendMessage`), signés
« — {{centre}} ».

## Décision

- **Un gabarit HTML commun** (`notifications/gabarit.ts`, module pur) pour
  tous les courriels : moteur (`notify`), mot de passe oublié et confirmation
  d'adresse (`lib/auth/server.ts`), essai d'envoi. 600 px, tableaux et styles
  en ligne, Rubik puis Arial, **aucune police ni ressource distante** sauf le
  logo servi par le site. Couleurs de la charte : filet de tête `#1FABE3`
  (aplat, jamais de texte : 2,63:1), boutons et liens `#00487B` texte blanc
  (9,49:1), texte `#1A1A1A`, secondaire `#6B7280`.
- **Aucune exigence nouvelle pour les modèles**, présents ou à venir : le
  gabarit lit le texte rendu. Paragraphes = lignes vides ; « Libellé : lien »
  ou un lien seul sur sa ligne **vers le site** (`APP_URL`) = bouton (un lien
  vers un autre site reste un lien : un client ne dicte pas les actions du
  centre) ; « — » ouvre la signature, ce qui suit une ligne vide passe en pied
  de message. Lien seul : « Choisir mon mot de passe » pour
  `/reset-password/`, « Confirmer mon adresse » pour `/verify-email`, sinon
  « Ouvrir le lien ». Objet en titre, texte d'aperçu, `lang="fr"`, thème clair.
- **Version texte conservée** : envoi `multipart/alternative`. Le texte reçoit
  les mêmes lignes de signature sous le nom du centre. Le corps rendu
  retourné à l'appelant et le journal (objet seul) ne changent pas.
- **Réglage dans Configuration**, section « Courriels : logo et signature »
  (`centre.configurer`) : nom du centre (obligatoire), téléphone, site, lignes
  de signature (6 × 100 caractères ; vides = signature automatique : adresse,
  téléphone · adresse e-mail, site) ; logo PNG, JPEG ou SVG (1 Mo) ; aperçu de
  chaque modèle (valeurs fictives, largeur ordinateur ou 375 px) et envoi de
  cet exemple à sa propre adresse. L'encart « Courriels » de Réglages propose
  aussi l'essai de chaque modèle.
- **Logo** : déposé dans le stockage S3 européen
  (`centre/<centre>/logo-courriels/<id>.<ext>`), servi par
  `/medias/centre/logo/<id>.<ext>`, public, gardé un an, CSP `sandbox`. Un SVG
  à script, gestionnaire d'événement, entité ou référence externe est refusé.
  Un logo remplacé n'est pas effacé : les courriels reçus l'affichent encore.
  Sans logo déposé, le logo du site (`logo_path`, `public/`) ; dimensions lues
  dans le fichier pour `width`/`height` (Outlook). **Le logo n'apparaît que si
  `APP_URL` est en HTTPS** (ou sur la boucle locale) ; sinon le nom du centre.

## Choix par défaut, à confirmer en recette

- Le logo déposé ne vaut **que pour les courriels** ; le site garde le sien
  (`next/image` refuserait un SVG servi par une route).
- SVG accepté comme demandé, mais **Gmail et Outlook ne l'affichent pas** :
  l'écran recommande le PNG ; JPEG accepté en plus, WebP refusé (Outlook).
- Signature automatique tirée de l'identité du centre ; nom, téléphone et site
  deviennent réglables dans Configuration (ils l'étaient par
  `infra/configurer-centre.mjs`, qui les remet s'il est rejoué).
- Couleurs de la charte fixes, non réglables par centre.
- Les modèles sans « — » reçoivent la signature à la fin (texte et HTML).

## Alternatives écartées

- **Logo en pièce jointe (CID)** : alourdit chaque envoi, refusé par la recette.
- **Modèles en HTML éditables** : chaque lot qui ajoute un événement devrait
  écrire du HTML ; le texte brut reste la source (ADR 038).
- **Bibliothèque de courriels (MJML, react-email)** : dépendance nouvelle.

## Conséquences

Tests : `gabarit.test.ts` (dont tous les modèles du catalogue),
`logo-courriels.test.ts`, `identite.test.ts`, `identite-queries.test.ts`,
`rendu.test.ts`, `courriel.test.ts` (envoi en deux parties),
`moteur.db.test.ts` (texte signé, HTML joint). Pas de règle en base hors deux
`CHECK` ; ni fichier de règles ni code d'erreur.
