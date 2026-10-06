# ADR 042 — nginx devant l'application, à la place d'Apache

**Date** : 2026-10-06
**Statut** : accepté — amende l'ADR 013 (hébergement) sur le serveur web
frontal ; le plafond d'envoi de l'ADR 015 passe d'Apache à nginx

## Contexte

L'ADR 013 confie le domaine et HTTPS à « l'Apache en place » sur le VPS de
production, et le dépôt fournissait `infra/serveur/apache-handfield.conf`. À
l'installation, le serveur web qui sert les autres sites du VPS est nginx, pas
Apache (constat de l'installateur, 06/10/2026). Deux serveurs web ne peuvent
pas écouter tous les deux sur les ports 80 et 443.

## Décision

**Le nginx en place sert `www.handfield.fr` et HTTPS**, en proxy vers le
conteneur sur `127.0.0.1:3100` : le port 3000 du serveur est déjà pris par
Open WebUI, et y envoyer handfield aurait servi cet autre service sous le
domaine. Le reste de l'ADR 013 ne change pas :
conteneur publié sur la boucle locale, image construite par la CI, base chez
Neon, certificat Let's Encrypt obtenu par certbot en `--webroot`, `www` comme
adresse canonique.

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
| `LimitRequestBody 23068672` (ADR 015) | `client_max_body_size 22m`, soit les mêmes 23 068 672 octets |
| redirection du domaine nu vers `www`, chemin compris | `return 301 https://www.handfield.fr$request_uri` |
| journaux `handfield-*.log` | `/var/log/nginx/handfield-*.log` |

`apache-handfield.conf` est retiré du dépôt, et la CI dépose les deux fichiers
nginx à sa place.

## Justification

Réutiliser le serveur web déjà en place est la raison d'être de l'ADR 013.
Ajouter Apache pour coller au texte de l'ADR imposerait un second serveur web
et un proxy de plus, sans rien gagner.

Deux fichiers plutôt qu'un : nginx n'a pas d'équivalent de `<IfFile>`, qui
permettait au fichier Apache d'être activé avant que le certificat existe. Un
bloc HTTPS qui cite un certificat absent fait échouer `nginx -t`, et un
rechargement raté touche tous les sites du serveur, pas seulement celui-ci.

## Alternatives écartées

**Installer Apache à côté de nginx** : les ports 80 et 443 sont déjà pris.
Faire passer Apache derrière nginx, c'est deux proxys en série pour un seul
site.

**`certbot --nginx`**, le module qui obtient le certificat et réécrit la
configuration : la configuration en place sur le serveur divergerait de celle
du dépôt, et la redirection vers `www` serait à refaire à la main. En
`--webroot`, certbot n'obtient que le certificat et la configuration reste
celle du dépôt.

## Conséquences

Positives : même comportement qu'avec Apache. Les deux fichiers ont été
vérifiés sur un nginx 1.24, avec un certificat de test et une fausse
application : `nginx -t` passe à chaque étape, les redirections conservent le
chemin, l'application reçoit l'hôte public et `https`, et un envoi de 24 Mo est
refusé en 413 alors qu'un envoi de 21 Mo passe.

Négatives : l'installation se fait en deux temps, et le fichier HTTPS doit
rester désactivé tant que le certificat n'existe pas. Pas d'écoute IPv6, car le
DNS ne publie pas d'AAAA (README, section 6) : en publier un demande d'ajouter
`listen [::]:80;` et `listen [::]:443 ssl;`. La rotation des journaux est celle
du paquet nginx de Debian (14 jours), à vérifier sur le serveur comme l'était
celle d'Apache (`docs/rgpd/durees-de-conservation.md`, M6).
