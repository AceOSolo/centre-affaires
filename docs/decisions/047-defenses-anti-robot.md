# ADR 047 — Défenses contre les robots sur ce qui s'écrit sans compte

**Date** : 2026-10-20
**Statut** : accepté

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
2. **Champ piège** (`lib/champ-piege.ts`, `ChampPiege`) dans les deux
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

## Justification

Le plafond par IP arrête un robot seul ; le plafond du site arrête un robot
réparti sur beaucoup d'adresses, au prix, en cas d'attaque, d'un formulaire
momentanément fermé — l'accueil reste joignable. Trente demandes en ligne par
heure dépassent de loin l'activité d'un centre.

Compteurs en mémoire : l'application tourne en un seul conteneur (ADR 013) et
rien de nouveau n'est à installer. Ils repartent de zéro à chaque
redémarrage, ce qui suffit contre un robot.

## Alternatives écartées

- **CAPTCHA (reCAPTCHA, hCaptcha, Turnstile)** : service tiers hors UE pour
  la plupart, appel à un domaine extérieur à chaque visite (contrainte
  d'hébergement EU, comme les polices), et gêne pour l'accessibilité. À
  reconsidérer seulement si les plafonds ne suffisent pas ; une solution
  auto-hébergée (preuve de travail, type ALTCHA) serait alors préférée.
- **Stockage des compteurs en base** : utile à plusieurs conteneurs, inutile
  à un seul, et une écriture de plus par demande.
- **Politique de sécurité de contenu complète (CSP des scripts)** : Next
  injecte des scripts en ligne, il faudrait un nonce par requête et donc
  renoncer au rendu statique. Reportée ; seul `frame-ancestors` est posé.

## Conséquences

- Un second conteneur exigerait un stockage commun des compteurs (base ou
  Redis), pour le site comme pour Better Auth.
- Si Apache cessait d'ajouter `X-Forwarded-For`, tous les visiteurs
  partageraient un même compteur : la configuration d'`infra/serveur` doit
  rester un `ProxyPass` d'Apache.
- Une entreprise dont tous les salariés sortent par la même adresse IP est
  limitée à cinq demandes en ligne par heure ; au-delà, elle appelle
  l'accueil ou passe par son espace client.
