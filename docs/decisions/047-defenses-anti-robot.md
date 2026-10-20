# ADR 047 — Défenses contre les robots sur ce qui s'écrit sans compte

**Date** : 2026-10-20
**Statut** : accepté ; preuve de travail ALTCHA ajoutée le même jour à la
demande du centre (point 6)

## Contexte

Deux portes s'ouvrent sans compte : la demande de réservation ou de devis du
site public (ADR 005, 043) et l'inscription libre (ADR 045).

- **Une demande en attente occupe son créneau** : le trigger anti-chevauchement
  de `bookings` (décision 3) compte toute réservation non annulée. Le seul
  frein était un quota de cinq demandes par adresse électronique et par jour
  (`requests.ts`). Un robot qui invente une adresse à chaque envoi bloquait
  donc tout le planning, et chaque demande prévient l'accueil par courriel.
  Les devis de domiciliation n'avaient aucun plafond.
- **Better Auth** limite déjà ses appels par adresse IP en production, mais
  large : trois essais en dix secondes, soit plus d'un millier par heure, pour
  la connexion comme pour l'inscription. Chaque inscription fait partir un
  courriel de confirmation vers l'adresse saisie, quelle qu'elle soit.
- Le site ne posait **aucun en-tête de sécurité** : il pouvait être affiché
  dans le cadre d'un autre site (détournement de clic).

## Décision

1. **Plafonds des demandes publiques** (`modules/reservations/public-actions.ts`,
   `lib/anti-robot.ts`), salles, véhicule et domiciliation confondus : cinq
   demandes par heure et par adresse IP, trente par heure pour tout le site.
   Comptées après la validation, juste avant l'écriture : une personne qui
   corrige ses réponses ne s'épuise pas. Au-delà, le visiteur est renvoyé vers
   l'accueil.
2. **Champ piège** (`lib/champs-anti-robot.ts`, `ChampPiege`) dans les deux
   formulaires publics : hors de l'écran, hors de la tabulation, masqué aux
   lecteurs d'écran. Rempli, la demande est refusée avec un message neutre
   (« contactez-nous directement ») plutôt qu'un faux succès, au cas où une
   personne l'aurait rempli.
3. **Better Auth resserré** (`lib/auth/server.ts`) : connexion 10 essais par
   5 minutes, inscription 5 par heure, renvoi de confirmation 3 par
   15 minutes, par adresse IP. La page de connexion traduit le refus (429).
4. **Une seule lecture de l'adresse IP**, partagée par le site et Better Auth
   (`adresseIpDerriereApache`) : la dernière entrée de `X-Forwarded-For`,
   celle qu'ajoute Apache ; ce qui est à sa gauche vient du visiteur et peut
   être inventé. IPv6 ramenée au réseau /64.
5. **En-têtes de sécurité** (`next.config.ts`) : interdiction d'affichage dans
   un cadre (`X-Frame-Options`, `frame-ancestors`), `nosniff`, politique de
   référent, HSTS d'un an, et plus d'en-tête `X-Powered-By`.
6. **Preuve de travail ALTCHA** (`lib/preuve-humaine.ts`,
   `components/ui/preuve-humaine.tsx`) sur les deux formulaires publics et sur
   la création de compte : une case « Je ne suis pas un robot » qui se coche
   seule après un calcul de quelques secondes dans le navigateur, pendant la
   saisie. Le défi est servi par l'application (`/api/anti-robot`, 30 par
   10 minutes et par IP), la réponse vérifiée par elle : signée (secret dérivé
   d'`AUTH_SECRET`), valable 30 minutes, **une seule fois**. Le formulaire
   recrée la case après chaque réponse du serveur. Pour l'inscription, la
   réponse voyage dans l'en-tête `x-preuve-humaine`, contrôlé par un crochet
   de Better Auth avant toute création de compte. Réglage mesuré : PBKDF2,
   coût 2 000, 2 000 à 4 000 tentatives (3,5 s sur un seul cœur ; la
   vérification prend une milliseconde).

## Justification

Le plafond par IP arrête un robot seul ; le plafond du site arrête un robot
réparti sur beaucoup d'adresses, au prix, en cas d'attaque, d'un formulaire
momentanément fermé — l'accueil reste joignable. Trente demandes en ligne par
heure dépassent de loin l'activité d'un centre.

Compteurs en mémoire : l'application tourne en un seul conteneur (ADR 013) et
rien de nouveau n'est à installer. Ils repartent de zéro à chaque
redémarrage, ce qui suffit contre un robot.

Une preuve de travail fait payer chaque envoi en calcul : rien pour une
personne, qui n'envoie qu'une demande ; des heures de processeur pour un robot
qui en enverrait des milliers, même réparti sur beaucoup d'adresses. ALTCHA
est un logiciel libre (licence MIT) **entièrement auto-hébergé** : ni service
tiers, ni cookie, ni pistage, aucune donnée du visiteur ne quitte le serveur —
plus strict qu'un prestataire européen. Le widget vise WCAG 2.2 AA (case à
cocher ordinaire au clavier et au lecteur d'écran) et existe en français. Ses
couleurs sont celles de la charte ; pied de page et logo masqués.

Dépendances ajoutées, justifiées par ce qui précède : `altcha` (widget,
chargé dans le navigateur seulement) et `altcha-lib` (serveur), versions
figées et publiées depuis plus de deux semaines au moment de l'ajout.

## Alternatives écartées

- **CAPTCHA tiers (reCAPTCHA, hCaptcha, Turnstile)** : services hors UE,
  appel à un domaine extérieur à chaque visite (contrainte d'hébergement EU,
  comme les polices), puzzles d'images peu accessibles.
- **Prestataires européens (Friendly Captcha, captcha.eu…)** : hébergés en
  UE, mais un tiers de plus qui voit l'adresse IP des visiteurs, un contrat
  et un abonnement, pour le même principe de preuve de travail qu'ALTCHA
  fait chez nous.
- **Captchetat** (État français) : réservé aux administrations.
- **Stockage des compteurs en base** : utile à plusieurs conteneurs, inutile
  à un seul, et une écriture de plus par demande.
- **Politique de sécurité de contenu complète (CSP des scripts)** : Next
  injecte des scripts en ligne, il faudrait un nonce par requête et donc
  renoncer au rendu statique. Reportée ; seul `frame-ancestors` est posé.

## Conséquences

- Un second conteneur exigerait un stockage commun des compteurs et des
  réponses ALTCHA déjà servies (base ou Redis), pour le site comme pour
  Better Auth.
- Changer `AUTH_SECRET` invalide les défis en cours : les visiteurs en train
  de remplir un formulaire relancent la case.
- Sans JavaScript, plus d'inscription ni de demande en ligne ; l'accueil
  reste joignable.
- Si Apache cessait d'ajouter `X-Forwarded-For`, tous les visiteurs
  partageraient un même compteur : la configuration d'`infra/serveur` doit
  rester un `ProxyPass` d'Apache.
- Une entreprise dont tous les salariés sortent par la même adresse IP est
  limitée à cinq demandes en ligne par heure ; au-delà, elle appelle
  l'accueil ou passe par son espace client.
