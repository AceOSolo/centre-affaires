# ADR 014 — Un agenda Google par ressource

**Date** : 2026-09-30
**Statut** : proposé — le compromis RGPD ci-dessous est à valider

## Contexte

L'équipe suit l'occupation des salles dans Google Agenda et veut y retrouver
les réservations du centre sans les ressaisir. La demande initiale portait sur
les demandes acceptées (ADR 005). Elle a été précisée : **un agenda par salle**,
reliées depuis un espace d'administration, et qui montre **toutes les
réservations confirmées** de la salle — y compris celles posées par l'équipe.
Sans elles, l'agenda d'une salle réservée la montrerait libre.

C'est la première intégration du produit avec un service tiers qui **reçoit**
des données du centre. Elle touche deux engagements de `CLAUDE.md` :

- **RGPD** : « hébergement et stockage en région EU ». Google Agenda n'offre
  aucune garantie de localisation pour un compte Gmail ; Google Workspace ne la
  propose que dans ses offres Enterprise.
- **Dépendances** : aucune nouvelle sans justification.

## Décision

### Un compte Google pour le centre, connecté par un administrateur

L'espace « Agendas Google » (`/ressources/agendas`) est lisible par toute
l'équipe et modifiable par les seuls membres de rôle `admin` (ADR 008). Un
administrateur y connecte un compte Google (OAuth 2.0, code d'autorisation avec
PKCE). Une connexion par centre : table `google_calendar_connections`.

### Un agenda créé par l'application pour chaque ressource reliée

L'administrateur coche des ressources et clique « Créer l'agenda » :
l'application crée dans le compte l'agenda « *Salle* — *centre* » et note le
lien dans `resource_google_calendars`. Les réservations confirmées à venir de
la ressource y sont aussitôt recopiées. Une ressource non reliée n'est pas
écrite.

Scope demandé : `calendar.app.created`, plus `openid email` pour afficher le
compte connecté. L'application n'a accès qu'aux agendas qu'elle a créés. Elle
ne peut ni lire ni modifier les autres agendas du compte. Chaque agenda se
partage à l'équipe depuis Google Agenda, comme n'importe quel autre.

Les deux tables portent `tenant_id` et la RLS (migrations 0021 et 0022).

### Ce qui est écrit

| Réservation | Agenda de la ressource |
| --- | --- |
| Confirmée : demande acceptée, réservation de l'équipe, occurrence de série | écrite |
| En attente de validation | absente |
| Annulée, ou demande refusée | retirée |
| Indisponibilité (entretien, blocage) | absente |
| Déplacée dans une autre salle | retirée de l'ancienne, écrite dans la nouvelle |

L'identifiant de l'événement Google est dérivé de celui de la réservation
(l'hexadécimal d'un UUID est du base32hex valide). Il n'y a rien à stocker, et
chaque écriture est idempotente : rejouer une écriture remplace l'événement au
lieu de le dupliquer.

### L'écriture part après la réponse, une à une

`after()` de Next : la réservation est enregistrée et l'écran rendu, puis
l'application écrit chez Google. Un seul jeton d'accès par lot, et les
écritures les unes après les autres : une série de 500 occurrences ne déclenche
pas 500 appels simultanés. Un refus pour excès de débit est réessayé avec une
attente qui double (1, 2, 4 secondes), comme Google le recommande.

Un échec est inscrit sur la connexion (`last_error`) et affiché dans l'espace
des agendas jusqu'à la prochaine écriture réussie.

### Le jeton de rafraîchissement est chiffré en base

AES-256-GCM, clé `SECRETS_ENCRYPTION_KEY` propre à chaque environnement
(`src/lib/chiffrement.ts`). Une branche Neon copie les données de sa parente :
en clair, le jeton de production donnerait l'accès aux agendas depuis chaque
branche de développement.

### Déconnecter ou retirer ne supprime rien chez Google

La déconnexion révoque le jeton chez Google, puis supprime physiquement la
connexion et, par cascade, les liaisons des ressources. Le retrait d'une
ressource supprime sa liaison. Dans les deux cas, les agendas restent dans le
compte Google et ne sont plus tenus à jour : l'équipe a pu les partager ou les
annoter.

La suppression physique est une exception assumée à la décision 6 : une
connexion est un réglage, pas une entité métier à consulter après coup, et la
garder reviendrait à conserver un secret sans usage.

## Justification

**RGPD : minimisation plutôt que refus.** L'événement contient l'objet de la
réservation, la ressource, le créneau et un lien vers la fiche du back-office.
Il ne contient **ni le nom, ni le courriel, ni le téléphone du demandeur, ni les
notes** : ces données personnelles (ADR 005) restent en base, en UE. Un test
vérifie qu'aucune ne part chez Google. Reste l'objet, saisi librement par le
demandeur ou par l'équipe : il peut contenir un nom (« Entretien M. Dupont »).
C'est le compromis à valider. Le retirer ne laisserait dans l'agenda que des
créneaux occupés, sans rien pour les distinguer.

Google agit ici comme sous-traitant du centre. La connexion et la liaison de
chaque ressource sont des décisions de l'administrateur, réversibles, et rien
n'est envoyé pour une ressource non reliée.

**Pourquoi `calendar.app.created` plutôt que choisir un agenda existant.**
Relier une salle à un agenda déjà présent dans le compte demanderait la liste
des agendas et l'accès en lecture et en écriture à **tous** leurs événements.
Pour écrire des réservations, c'est un accès disproportionné. Un agenda créé
par l'application se partage, se masque et se colore dans Google comme un
autre : l'usage reste le même, avec un accès bien plus étroit.

**Pourquoi un compte pour le centre plutôt qu'un par salle ou par membre.**
Une seule connexion à tenir, un seul jeton à protéger. Relier Google à la
connexion de chaque membre (fournisseur Google de Neon Auth) mêlerait
authentification et intégration, ce que l'ADR 008 sépare précisément.

**Pourquoi toutes les réservations confirmées.** L'agenda d'une salle sert à
savoir si elle est libre. S'il ne montrait que les demandes acceptées, une
salle réservée par l'équipe y paraîtrait libre. Les indisponibilités restent
dehors : ce ne sont pas des réservations, et l'agenda n'a pas vocation à
refléter la maintenance.

**Pourquoi `fetch` plutôt que le SDK `googleapis`.** Six points d'entrée REST :
autorisation, jeton, révocation, création d'agenda, écriture et suppression
d'événement. Le SDK pèse des dizaines de mégaoctets dans l'image Docker
(ADR 013) pour ça. Aucune dépendance ajoutée.

**Pourquoi après la réponse.** Une réservation est un fait métier, acquis en
base. Google lent ou en panne ne doit ni la retarder ni la faire échouer, et
une série de 500 occurrences prendrait plusieurs minutes à écrire.

## Mise en place

Dans la console Google Cloud, pour chaque environnement (développement,
production) :

1. Créer un projet et y activer **Google Calendar API**.
2. Écran de consentement OAuth : ajouter les scopes `openid`, `email` et
   `https://www.googleapis.com/auth/calendar.app.created`.
   - Type **Interne** si le compte à connecter appartient au même Google
     Workspace que le projet : ni vérification, ni expiration.
   - Sinon (compte Gmail), type **Externe**, et **passer en production**. En
     mode « test », Google fait expirer le jeton au bout de sept jours et
     l'écriture s'arrête. Si la console classe le scope comme sensible,
     l'écran de consentement affichera « application non validée » : pour un
     seul compte administrateur, « Paramètres avancés > Continuer » suffit ;
     la validation par Google ne devient nécessaire qu'au-delà de 100
     utilisateurs.
3. Identifiants > ID client OAuth, type **Application Web**, URI de
   redirection autorisée : `APP_URL` suivi de `/ressources/agendas/retour`,
   par exemple `https://reservations.exemple.fr/ressources/agendas/retour`.
4. Renseigner `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` et
   `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`, différente par
   environnement). Tant qu'il en manque une, l'espace des agendas dit que
   l'intégration n'est pas configurée.

## Conséquences

**Pas de reprise automatique.** Un échec est affiché, pas rejoué, hormis les
refus pour excès de débit. Un redémarrage du serveur pendant un lot perd la
suite du lot sans laisser de trace. Si cela devient un problème, un bouton
« Resynchroniser » n'aurait qu'à rejouer la recopie des réservations à venir :
l'écriture est déjà idempotente.

**Le passé n'est pas recopié.** À la création d'un agenda, seules les
réservations qui ne sont pas terminées y sont écrites.

**Une reconnexion repart de zéro.** Changer de compte, ou se déconnecter puis se
reconnecter, retire toutes les liaisons. Recréer les agendas en crée de
nouveaux ; les anciens restent dans le compte Google.

**Sens unique.** Une modification faite dans Google Agenda n'est pas relue et
sera écrasée à la prochaine écriture. L'application fait foi.

**Environnements.** Une branche copiée depuis la production contient la
connexion, mais son jeton est illisible avec la clé de développement.
L'écriture échoue avec un message qui invite à connecter un compte de test :
c'est voulu.

## Alternatives écartées

**Choisir un agenda existant par salle** (agenda partagé, ressource Workspace).
Voir la justification : l'accès demandé à Google serait disproportionné.

**Un compte Google par salle.** Autant de connexions et de jetons que de
salles, pour un résultat qu'un agenda par salle dans un seul compte donne déjà.

**Flux iCal auquel Google s'abonne.** Pas d'OAuth, pas de jeton. Écarté :
Google relit un flux externe à son rythme, parfois une fois par jour. Et l'URL
du flux, secrète mais permanente, donnerait accès aux réservations à quiconque
la connaît.

**Compte de service Google.** Il écrit dans l'agenda d'un utilisateur seulement
avec une délégation à l'échelle d'un domaine Workspace. Il ne fonctionne pas
avec un compte Gmail.

**Écriture dans l'action, avant la réponse.** Elle permettrait d'afficher
l'échec dans le formulaire. Écartée : chaque réservation attendrait Google, et
une panne de Google ferait échouer une réservation déjà acquise en base.
