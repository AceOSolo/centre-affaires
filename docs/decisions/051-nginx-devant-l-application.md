# ADR 051 — nginx devant l'application, à la place d'Apache

**Date** : 2026-10-20
**Statut** : accepté — amende l'ADR 013 (hébergement) sur le serveur web
frontal et le port local de l'application ; le plafond d'envoi de l'ADR 015
et la lecture de l'adresse IP de l'ADR 047 passent d'Apache à nginx. Reprend,
renuméroté et adapté à MySQL, un ADR écrit le 06/10/2026 sur une branche
jamais fusionnée (`claude/npm-lock-file-sync-cbbjgr`, fichier
`042-nginx-devant-l-application.md`), dont le numéro a depuis été attribué à
l'ADR 042 (MySQL sur le VPS)

## Contexte

L'ADR 013 confie le domaine et HTTPS à « l'Apache en place » sur le VPS de
production, et le dépôt fournissait `infra/serveur/apache-handfield.conf`. À
l'installation du 06/10/2026, le serveur web qui sert les autres sites du VPS
s'est révélé être **nginx**, pas Apache (constat de l'installateur ; la
production répond `Server: nginx/1.22.1`, vérifié le 20/10/2026). Deux
serveurs web ne peuvent pas écouter tous les deux sur les ports 80 et 443.

Le port 3000 de l'hôte, où le compose publiait l'application par défaut, est
pris par Open WebUI : y envoyer `handfield.fr` aurait servi cet autre service
sous le domaine.

Ces deux constats ont été appliqués sur le serveur et écrits le 06/10 sur une
branche qui n'a jamais été fusionnée : `main` a continué de décrire Apache et
le port 3000. Entre-temps, la base est passée de Neon à MySQL, dans le même
compose que l'application (ADR 042). Cet ADR reprend la décision dans ce
cadre.

## Décision

**Le nginx en place sert `www.handfield.fr` et HTTPS**, en proxy vers le
conteneur `app` publié sur **`127.0.0.1:3100`** (`PORT_LOCAL`, 3100 par
défaut dans `infra/serveur/compose.yml`). À l'intérieur du conteneur,
l'application écoute toujours sur 3000 (`Dockerfile`) : seul le port de
l'hôte change, et les tâches planifiées qui appellent l'application depuis
son conteneur (`docker compose exec app … http://127.0.0.1:3000/…`,
`infra/serveur/README.md`) restent telles quelles.

Le reste de l'ADR 013 ne change pas : conteneur publié sur la boucle locale
seulement, certificat Let's Encrypt obtenu par certbot en `--webroot`, `www`
comme adresse canonique. La base est le service `db` du même compose, publié
sur aucun port (ADR 042) : nginx n'y a pas accès et n'en a pas besoin.

**Deux fichiers, installés l'un après l'autre** (`infra/serveur/README.md`,
section 7) :

- `nginx-handfield-http.conf`, port 80 : validation Let's Encrypt, puis
  redirection de tout le reste vers `https://www.handfield.fr` ;
- `nginx-handfield-https.conf`, port 443 : redirection du domaine nu, proxy
  vers l'application, activé une fois le certificat obtenu.

Les règles du fichier Apache sont reprises une à une :

| Apache | nginx |
|---|---|
| `ProxyPreserveHost On` | `Host` et `X-Forwarded-Host` transmis |
| `RequestHeader set X-Forwarded-Proto "https"` | `X-Forwarded-Proto https` |
| `X-Forwarded-For`, ajouté d'office par `mod_proxy` | `X-Forwarded-For $proxy_add_x_forwarded_for` : l'adresse du visiteur en dernière position, celle que lisent les plafonds anti-robot et Better Auth (ADR 047) |
| `LimitRequestBody 23068672` (ADR 015) | `client_max_body_size 22m`, soit les mêmes 23 068 672 octets |
| redirection du domaine nu vers `www`, chemin compris | `return 301 https://www.handfield.fr$request_uri` |
| journaux `handfield-*.log` | `/var/log/nginx/handfield-*.log` |

`apache-handfield.conf` est retiré du dépôt.

## Justification

Réutiliser le serveur web déjà en place est la raison d'être de l'ADR 013.
Ajouter Apache pour coller au texte de l'ADR imposerait un second serveur web
et un proxy de plus, sans rien gagner.

Deux fichiers plutôt qu'un : nginx n'a pas d'équivalent de `<IfFile>`, qui
permettait au fichier Apache d'être activé avant que le certificat existe. Un
bloc HTTPS qui cite un certificat absent fait échouer `nginx -t`, et un
rechargement raté touche tous les sites du serveur, pas seulement celui-ci.

3100 plutôt qu'un port choisi au cas par cas : la valeur par défaut du
compose est celle du serveur réel, et le fichier nginx du dépôt la cite. Un
`.env` sans `PORT_LOCAL` donne donc une configuration juste.

## Alternatives écartées

**Installer Apache à côté de nginx** : les ports 80 et 443 sont déjà pris.
Faire passer Apache derrière nginx, c'est deux proxys en série pour un seul
site.

**`certbot --nginx`**, le module qui obtient le certificat et réécrit la
configuration : la configuration en place sur le serveur divergerait de celle
du dépôt, et la redirection vers `www` serait à refaire à la main. En
`--webroot`, certbot n'obtient que le certificat et la configuration reste
celle du dépôt.

**Garder 3000 et déplacer Open WebUI** : un service étranger à l'application
à reconfigurer, pour un numéro de port.

## Conséquences

Positives : même comportement qu'avec Apache. Les deux fichiers ont été
vérifiés le 06/10 sur un nginx 1.24, avec un certificat de test et une fausse
application : `nginx -t` passe à chaque étape, les redirections conservent le
chemin, l'application reçoit l'hôte public et `https`, et un envoi de 24 Mo
est refusé en 413 alors qu'un envoi de 21 Mo passe. Le serveur tourne en
1.22.1 ; aucune des directives employées n'est plus récente.

Négatives et points à suivre :

- L'installation se fait en deux temps, et le fichier HTTPS doit rester
  désactivé tant que le certificat n'existe pas.
- Pas d'écoute IPv6, car le DNS ne publie pas d'AAAA (README, section 6) :
  en publier un demande d'ajouter `listen [::]:80;` et `listen [::]:443 ssl;`.
- La rotation des journaux est celle du paquet nginx de Debian (14 jours), à
  vérifier sur le serveur comme l'était celle d'Apache
  (`docs/rgpd/durees-de-conservation.md`, M6). Le jeton de l'API Dolibarr,
  passé dans l'adresse du webhook des produits (ADR 049), figure dans les
  journaux d'accès de nginx comme il aurait figuré dans ceux d'Apache.
- Si nginx cessait de transmettre `X-Forwarded-For`, tous les visiteurs
  partageraient un même compteur anti-robot et de connexion (ADR 047). La
  vérification après chaque mise en ligne le contrôle (README, section 4).
- Les mentions d'Apache des ADR 015 (plafond de 22 Mo), 047 (lecture de
  `X-Forwarded-For`) et 049 (journaux) se lisent désormais « nginx » : un ADR
  accepté ne se réécrit pas. Le nom `adresseIpDerriereApache` du code
  (`src/lib/anti-robot.ts`) est un héritage ; la règle qu'il porte (seule la
  dernière entrée de `X-Forwarded-For` fait foi, la boucle locale est le seul
  relais de confiance) vaut telle quelle derrière nginx.
- **Déploiement.** L'ADR 013 prévoyait que la CI dépose `compose.yml` et le
  fichier du serveur web à chaque déploiement. Le job `deploy` a été retiré
  de la CI le 15/10/2026 (commit `e469801`, passage à MySQL) et n'est pas
  rétabli : le dernier déploiement automatique date du 06/10/2026. Les
  fichiers nginx, comme `compose.yml` et `sauvegarde.sh`, se déposent donc à
  la main, à chaque mise en ligne (`infra/serveur/README.md`, section 4).
  Rétablir le déploiement automatique est une décision en attente.
