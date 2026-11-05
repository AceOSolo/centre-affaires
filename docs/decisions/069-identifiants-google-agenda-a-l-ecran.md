# ADR 069 — Identifiants Google Agenda réglés à l'écran, par centre

**Date** : 2026-11-05
**Statut** : remplacé par l'ADR 071 le même jour (lien d'agenda par ressource,
connexion Google retirée) ; table `google_oauth_clients` en sommeil. Amendait
l'ADR 014 (« Mise en place », point 4 :
`GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` ne sont plus nécessaires sur le
serveur), sur le modèle de l'ADR 065 (réglage par centre, ancienne variable
acceptée tant que rien n'est réglé à l'écran)

## Contexte

Pour connecter le compte Google du centre (ADR 014), le site a besoin d'un
**client OAuth** déclaré dans Google Cloud : un ID client et son code secret.
Ils étaient lus dans deux variables du serveur. Tant qu'elles manquaient,
l'espace des agendas (`/ressources/agendas`) affichait « Non configuré sur ce
serveur : renseigner GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET… » et rien n'était
possible depuis l'écran.

Demande du 05/11/2026 : la gestion des agendas Google se fait **en un clic
depuis cette page**, pas par des valeurs écrites en dur sur le serveur. C'est
aussi ce que demande la vente à d'autres centres (ADR 065) : chaque centre
règle ses intégrations depuis son espace.

Google n'offre aucun moyen d'écrire dans un agenda sans client OAuth déclaré
chez lui. Ce client se crée une fois, dans Google Cloud, avec le compte du
centre. Le site ne peut pas le créer à sa place.

## Décision

### 1. L'ID client et le code secret se collent dans l'espace des agendas

Tant qu'aucun compte Google n'est connecté, l'espace montre à
l'administrateur un bloc « Identifiants Google Cloud » :

- la marche à suivre chez Google en quatre étapes, avec un lien direct vers
  chaque page de la console (activer Google Calendar API, écran de
  consentement, création du client OAuth) ;
- **l'URI de redirection prête à copier** (`APP_URL` suivi de
  `/ressources/agendas/retour`) : c'est l'erreur la plus courante chez Google,
  elle doit être recopiée à l'identique ;
- deux champs, ID client et code secret, et un seul bouton
  **« Enregistrer et connecter le compte Google »**.

Ce bouton éprouve les identifiants, les enregistre, puis part aussitôt vers la
page de consentement de Google. Coller les identifiants et connecter le compte
ne font qu'un clic. Une fois les identifiants enregistrés, une reconnexion est
le bouton « Connecter un compte Google », seul.

Déjà réglés, les identifiants restent sous un bloc replié (ID client et date),
pour changer de projet Google Cloud. Le bloc disparaît dès qu'un compte est
connecté, et le serveur refuse de changer d'identifiants tant qu'il l'est : le
jeton du compte a été délivré au client précédent, il ne se renouvellerait pas
avec un autre.

### 2. Les identifiants sont vérifiés avant de partir chez Google

La page de consentement de Google ne lit que l'ID client. Un code secret mal
collé ne se verrait qu'au retour, par un échec sans explication. Avant
d'enregistrer, le site présente donc à Google un code d'autorisation
volontairement faux avec les identifiants saisis :

| Réponse de Google | Sens | Suite |
| --- | --- | --- |
| `invalid_client` | ID client ou code secret inconnu | refusé, erreur sur le champ |
| `invalid_grant` | identifiants bons, seul le code est refusé | enregistré, départ chez Google |
| autre, ou pas de réponse | on ne sait pas | enregistré, départ chez Google |

Seul un refus explicite bloque : une panne de Google ne doit pas empêcher de
régler l'écran.

### 3. Une table par centre, `google_oauth_clients`

Une ligne au plus par centre (`tenant_id` unique) : ID client, code secret
chiffré par `sealSecret` (`SECRETS_ENCRYPTION_KEY`, comme le jeton du compte et
la clé du CRM), auteur de la dernière modification. Le code secret n'est
jamais réaffiché.

Elle est distincte de `google_calendar_connections` : la connexion est
l'accès d'un compte Google, supprimée à la déconnexion (ADR 014) ; le client
est l'application déclarée chez Google, il survit à la déconnexion. Un
réglage, pas une entité métier : il se remplace sur place.

Migration de structure seule ; les triggers de garde par centre (`CA014`) sont
posés par le migrateur comme sur toute table portant `tenant_id`.

### 4. Les variables du serveur restent un repli

`GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` valent pour un centre **tant
qu'aucun identifiant n'est réglé à l'écran**, comme `DOLIBARR_API_TOKEN` pour
le CRM (ADR 065). Un serveur déjà configuré par variables continue de marcher.
Pour un éditeur qui vendrait le produit avec un seul projet Google Cloud, ce
repli donne le « un clic » sans aucune saisie.

Des identifiants d'écran illisibles (code secret chiffré par une autre clé de
serveur, après une restauration) ne laissent pas la place aux variables :
l'écran dit de les ressaisir.

### 5. Ce qui reste un réglage du serveur

- `APP_URL` : elle sert déjà à la connexion de l'équipe (better-auth) et
  compose l'URI de redirection.
- `SECRETS_ENCRYPTION_KEY` : c'est la clé qui protège les secrets gardés en
  base. La mettre en base n'aurait aucun sens. Sans elle, l'écran le dit et
  n'affiche pas le formulaire.

## Justification

**Pourquoi pas un vrai « zéro saisie ».** Il faudrait un client OAuth commun,
déclaré par l'éditeur du logiciel et posé sur le serveur : c'est exactement la
valeur en dur dont la demande veut se passer, et il ne couvrirait pas un centre
qui veut garder ses données dans son propre projet Google Cloud. Le repli du
§ 4 le permet pour qui le veut, sans l'imposer.

**Pourquoi refuser le changement d'identifiants pendant une connexion.** Le
jeton de rafraîchissement est lié au client qui l'a obtenu. Changer de client
sans reconnecter couperait l'écriture au prochain renouvellement, avec une
erreur que l'équipe ne saurait pas relier au changement.

**Pourquoi un faux code plutôt que rien.** Aucun point d'entrée de Google ne
valide un client. L'échange d'un code faux est sans effet de bord (aucun jeton
n'est délivré) et distingue, par la réponse normalisée d'OAuth (RFC 6749
§ 5.2), un client inconnu d'un code refusé. Vérifié le 05/11/2026 : un ID
client inventé reçoit `401 invalid_client`.

**Aucune dépendance ajoutée.** Un appel `fetch` de plus au point de
terminaison des jetons, déjà utilisé.

## Alternatives écartées

**Garder les variables du serveur et documenter mieux.** La demande est
précisément de ne plus passer par le serveur, et chaque centre doit pouvoir
régler le sien.

**Une page de réglage à part, à côté de « Connexion au CRM ».** L'espace des
agendas est déjà rangé dans Réglages (`reglages/sections.ts`), c'est le seul
endroit où ces identifiants servent, et l'administrateur y est quand il veut
connecter le compte : deux écrans pour un seul geste, c'est le contraire du
« un clic ».

**Compte de service Google.** Écarté par l'ADR 014 : il n'écrit pas dans un
compte Gmail.

## Conséquences

- Un centre règle Google Agenda sans intervention sur le serveur, dès lors
  que `SECRETS_ENCRYPTION_KEY` et `APP_URL` y sont posées.
- Changer de projet Google Cloud demande de déconnecter le compte, puis de
  coller les nouveaux identifiants. Comme toute reconnexion (ADR 014), les
  liaisons des ressources sont à refaire.
- Une rotation du code secret dans Google Cloud, sans changer de client, se
  fait de la même façon : déconnexion, puis nouveau code secret. C'est rare ;
  si cela devient courant, autoriser le seul remplacement du code secret pour
  le même ID client pendant une connexion.
- Une restauration sur un serveur à la clé différente rend le code secret
  illisible, comme le jeton : l'écran le dit et redemande les deux.
