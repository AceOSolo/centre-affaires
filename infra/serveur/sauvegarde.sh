#!/usr/bin/env bash
# Sauvegarde nocturne de l'application (R30, ADR 022).
#
# Chaque passage produit un « lot », nommé par son instant UTC
# (`2026-10-01T023000Z`) :
#
#   base.dump.age           pg_dump de la base Neon, format custom
#   stockage.tar.age        copie du bucket `uploads` (courrier numérisé)
#   configuration.tar.age   fichiers du serveur (le `.env` de l'application…)
#   SHA256SUMS              empreintes des fichiers chiffrés
#   manifeste.txt           contenu du lot. Il est envoyé en dernier : sa
#                           présence marque le lot comme complet.
#
# Tout est chiffré sur le serveur avec age, pour une ou plusieurs clés
# publiques. Le serveur peut donc chiffrer, jamais déchiffrer. Le lot part
# ensuite hors du serveur (rclone). Enfin, les lots que la rétention ne garde
# plus sont effacés.
#
# Usage :
#   sauvegarde.sh                          # lit ~/centre-affaires/sauvegarde.env
#   SAUVEGARDE_CONFIG=/chemin sauvegarde.sh
#
# Code de sortie 0 : le lot est complet, envoyé et vérifié. Tout autre code
# signale un échec, inscrit au journal (SAUVEGARDE_JOURNAL) et dans syslog.
#
# Installation et crontab : infra/serveur/README.md, section « Sauvegardes ».
# Restauration : docs/exploitation/restauration.md.
#
# Outils : bash, coreutils, age, rclone, flock (paquets Debian), et Docker
# pour pg_dump 18 (image postgres:18-alpine). Aucune dépendance npm.

LOT_MOTIF='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z$'

# Le journal s'écrit sur son propre descripteur (3, ouvert par `principal`) :
# un message émis pendant `pg_dump … >fichier` partirait sinon dans le fichier.
journal() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&"${journal_fd:-1}"; }

octets() { numfmt --to=iec-i --suffix=o "$1" 2>/dev/null || printf '%s o' "$1"; }

# Lots à garder parmi ceux reçus sur l'entrée standard, un nom par ligne.
#
# Règle « grand-père, père, fils » : on garde le lot le plus récent de chacun
# des $1 derniers jours, des $2 dernières semaines ISO et des $3 derniers mois
# qui ont un lot. Un même lot peut compter pour les trois. Les noms qui ne sont
# pas des lots ne sont ni comptés ni rendus.
lots_a_garder() {
  local quotidiennes=$1 hebdomadaires=$2 mensuelles=$3
  local lot jour semaine mois garder
  local -A jours=() semaines=() mois_vus=()
  local n_jours=0 n_semaines=0 n_mois=0

  while IFS= read -r lot; do
    [[ $lot =~ $LOT_MOTIF ]] || continue
    jour=${lot:0:10}
    mois=${lot:0:7}
    # Une date impossible (mois 13) n'est pas un lot.
    semaine=$(date -u -d "$jour" +%G-W%V 2>/dev/null) || continue
    garder=0

    # Les lots arrivent du plus récent au plus ancien : le premier lot d'une
    # période est le plus récent de cette période.
    if [[ -z ${jours[$jour]:-} ]]; then
      jours[$jour]=1
      n_jours=$((n_jours + 1))
      if ((n_jours <= quotidiennes)); then garder=1; fi
    fi
    if [[ -z ${semaines[$semaine]:-} ]]; then
      semaines[$semaine]=1
      n_semaines=$((n_semaines + 1))
      if ((n_semaines <= hebdomadaires)); then garder=1; fi
    fi
    if [[ -z ${mois_vus[$mois]:-} ]]; then
      mois_vus[$mois]=1
      n_mois=$((n_mois + 1))
      if ((n_mois <= mensuelles)); then garder=1; fi
    fi

    if ((garder)); then printf '%s\n' "$lot"; fi
  done < <(sort -r -u)
}

# Lots à effacer de la destination.
#
#   $1  le lot qui vient d'être envoyé, jamais effacé
#   $2  fichier : tous les lots présents (un nom par ligne)
#   $3  fichier : les lots complets, ceux qui ont leur manifeste
#   $4 $5 $6  rétention quotidienne, hebdomadaire, mensuelle
#
# Sont effacés les lots complets que la rétention ne garde pas, et les lots
# incomplets plus anciens que le lot courant : ce sont les restes d'un passage
# interrompu. Un nom qui n'a pas la forme d'un lot n'est jamais effacé.
lots_a_effacer() {
  local courant=$1 tous=$2 complets=$3
  local garder lot
  garder=$(lots_a_garder "$4" "$5" "$6" <"$complets")

  while IFS= read -r lot; do
    [[ $lot =~ $LOT_MOTIF ]] || continue
    if [[ $lot == "$courant" ]]; then continue; fi
    if grep -qxF -- "$lot" "$complets"; then
      if ! grep -qxF -- "$lot" <<<"$garder"; then printf '%s\n' "$lot"; fi
    elif [[ $lot < $courant ]]; then
      printf '%s\n' "$lot"
    fi
  done < <(sort -u "$tous")
}

# Arrêt sur erreur explicite : le message va au journal, puis on sort en échec.
fatal() {
  echec_message=$1
  return 1
}

echec() {
  local code=$1 ligne=$2 commande=$3
  # Une substitution de commande hérite du piège : seul le script principal
  # journalise, sans quoi chaque échec serait rapporté deux fois.
  if [[ $BASHPID != "$$" ]]; then exit "$code"; fi
  trap - ERR

  if [[ -n ${echec_message:-} ]]; then
    journal "ÉCHEC, étape « ${etape:-démarrage} » : $echec_message"
  else
    journal "ÉCHEC, étape « ${etape:-démarrage} » (ligne $ligne, code $code) : $commande"
  fi

  # Un lot à moitié envoyé est effacé : il ne doit pas passer pour un lot
  # du jour. S'il reste, le passage suivant l'efface (lot incomplet).
  if [[ -n ${envoi_commence:-} ]]; then
    if rclone purge "$SAUVEGARDE_DESTINATION/$lot" >/dev/null 2>&1; then
      journal "Lot partiel $lot effacé de la destination."
    else
      journal "Lot partiel $lot laissé sur la destination ; il sera effacé au prochain passage."
    fi
  fi

  if command -v logger >/dev/null 2>&1; then
    logger -p user.err -t centre-affaires-sauvegarde \
      "Sauvegarde en échec (étape ${etape:-démarrage}), voir ${JOURNAL:-le journal}" || true
  fi
  signaler /fail
  exit $((code == 0 ? 1 : code))
}

nettoyer() {
  if [[ -n ${travail:-} && -d $travail ]]; then rm -rf -- "$travail"; fi
}

# Signal facultatif à un service de surveillance : succès, ou `/fail`. Il
# détecte aussi une sauvegarde qui ne tourne plus du tout, ce qu'un code de
# sortie ne peut pas dire.
signaler() {
  if [[ -z ${SAUVEGARDE_SIGNAL_URL:-} ]]; then return 0; fi
  if ! command -v curl >/dev/null 2>&1; then
    journal "Signal non envoyé : curl absent."
    return 0
  fi
  curl -fsS -m 10 --retry 3 -o /dev/null "${SAUVEGARDE_SIGNAL_URL}$1" ||
    journal "Signal non envoyé à la surveillance."
}

charger_configuration() {
  etape="configuration"
  local fichier=${SAUVEGARDE_CONFIG:-$HOME/centre-affaires/sauvegarde.env}
  [[ -r $fichier ]] ||
    fatal "configuration illisible : $fichier (modèle : infra/serveur/sauvegarde.env.example)"

  # Le fichier porte des mots de passe : lisible par son seul propriétaire.
  local droits
  droits=$(stat -c %a "$fichier")
  [[ $droits == 600 || $droits == 400 ]] ||
    fatal "droits $droits sur $fichier : chmod 600 attendu"

  set -a
  # shellcheck source=/dev/null
  source "$fichier"
  set +a

  SAUVEGARDE_IMAGE_PG=${SAUVEGARDE_IMAGE_PG-postgres:18-alpine}
  SAUVEGARDE_TRAVAIL=${SAUVEGARDE_TRAVAIL:-/var/tmp}
  SAUVEGARDE_FICHIERS=${SAUVEGARDE_FICHIERS-}
  SAUVEGARDE_GARDER_QUOTIDIENNES=${SAUVEGARDE_GARDER_QUOTIDIENNES:-7}
  SAUVEGARDE_GARDER_HEBDOMADAIRES=${SAUVEGARDE_GARDER_HEBDOMADAIRES:-4}
  SAUVEGARDE_GARDER_MENSUELLES=${SAUVEGARDE_GARDER_MENSUELLES:-12}
  export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-30}
  # rclone ne journalise que ses erreurs ; le script dit lui-même ce qu'il a fait.
  export RCLONE_LOG_LEVEL=${RCLONE_LOG_LEVEL:-ERROR}

  local nom
  for nom in PGHOST PGDATABASE PGUSER SAUVEGARDE_SOURCE_STOCKAGE \
    SAUVEGARDE_DESTINATION SAUVEGARDE_DESTINATAIRES; do
    [[ -n ${!nom:-} ]] || fatal "$nom manquant dans $fichier"
  done

  # Les lots se placent sous la destination : pas de barre finale, qui
  # doublerait la barre de chaque chemin.
  SAUVEGARDE_DESTINATION=${SAUVEGARDE_DESTINATION%/}
  # La copie doit quitter le serveur : un chemin local n'est pas accepté.
  [[ $SAUVEGARDE_DESTINATION =~ ^[A-Za-z0-9_-]+: ]] ||
    fatal "SAUVEGARDE_DESTINATION doit désigner un emplacement distant rclone (« nom:chemin »)"
  [[ $SAUVEGARDE_SOURCE_STOCKAGE =~ ^[A-Za-z0-9_-]+: ]] ||
    fatal "SAUVEGARDE_SOURCE_STOCKAGE doit désigner le bucket (« nom:uploads »)"

  [[ $SAUVEGARDE_GARDER_QUOTIDIENNES =~ ^[1-9][0-9]*$ ]] ||
    fatal "SAUVEGARDE_GARDER_QUOTIDIENNES doit valoir au moins 1"
  [[ $SAUVEGARDE_GARDER_HEBDOMADAIRES =~ ^[0-9]+$ && $SAUVEGARDE_GARDER_MENSUELLES =~ ^[0-9]+$ ]] ||
    fatal "rétentions hebdomadaire et mensuelle : entiers positifs ou nuls attendus"

  # Seules des clés publiques sont admises : une clé privée sur le serveur
  # rendrait le chiffrement des sauvegardes inutile en cas d'intrusion.
  local destinataires=$SAUVEGARDE_DESTINATAIRES
  [[ -r $destinataires ]] || fatal "clés publiques introuvables : $destinataires"
  if grep -q 'AGE-SECRET-KEY' "$destinataires"; then
    fatal "$destinataires contient une clé privée age : elle n'a rien à faire sur le serveur"
  fi
  grep -q '^age1' "$destinataires" || fatal "aucune clé publique age (age1…) dans $destinataires"
}

verifier_outils() {
  etape="outils"
  local outil
  local -a outils=(age rclone tar sha256sum flock sort numfmt)
  if [[ -n $SAUVEGARDE_IMAGE_PG ]]; then outils+=(docker); else outils+=(pg_dump pg_restore); fi
  for outil in "${outils[@]}"; do
    command -v "$outil" >/dev/null 2>&1 || fatal "outil absent : $outil"
  done
  # Semaines ISO : date de GNU coreutils.
  date -u -d 2026-01-01 +%G >/dev/null 2>&1 || fatal "date de GNU coreutils attendue"
}

verrouiller() {
  etape="verrou"
  exec 9>"$SAUVEGARDE_TRAVAIL/centre-affaires-sauvegarde.lock"
  flock -n 9 || fatal "une autre sauvegarde est en cours"
}

# pg_dump et pg_restore dans l'image de Postgres 18 : Debian n'en fournit pas
# de version assez récente, et pg_dump refuse un serveur plus récent que lui.
# Les paramètres de connexion passent par l'environnement, jamais par la
# ligne de commande, que `ps` montre à tous les comptes du serveur.
pg_outil() {
  if [[ -n $SAUVEGARDE_IMAGE_PG ]]; then
    docker run --rm -i \
      -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
      -e PGSSLMODE -e PGSSLROOTCERT -e PGCHANNELBINDING -e PGCONNECT_TIMEOUT \
      "$SAUVEGARDE_IMAGE_PG" "$@"
  else
    "$@"
  fi
}

chiffrer() { age -R "$SAUVEGARDE_DESTINATAIRES" -o "$1"; }

sauvegarder_base() {
  etape="base"
  local dump=$travail/base.dump
  local -a options=()
  read -r -a options <<<"${SAUVEGARDE_PG_DUMP_OPTIONS:-}"

  pg_outil pg_dump --format=custom --no-password --lock-wait-timeout=120s "${options[@]}" >"$dump"
  pg_version=$(pg_outil pg_dump --version)

  # Relire la table des matières prouve que le fichier est un dump lisible,
  # et qu'il vient de la bonne base.
  pg_outil pg_restore --list <"$dump" >"$travail/base.liste"
  grep -Eq ' TABLE DATA public tenants( |$)' "$travail/base.liste" ||
    fatal "le dump ne contient pas la table tenants : PGDATABASE désigne-t-il la bonne base ?"
  grep -Eq ' TABLE DATA drizzle __drizzle_migrations( |$)' "$travail/base.liste" ||
    fatal "le dump ne contient pas le journal des migrations (schéma drizzle)"

  base_tables=$(grep -c ' TABLE DATA ' "$travail/base.liste")
  base_octets=$(stat -c %s "$dump")
  chiffrer "$travail/lot/base.dump.age" <"$dump"
  rm -f -- "$dump"
  journal "Base : $base_tables tables, $(octets "$base_octets") avant chiffrement."
}

sauvegarder_stockage() {
  etape="stockage"
  local copie=$travail/stockage
  mkdir -- "$copie"

  # rclone vérifie la taille et, quand la source la fournit, l'empreinte de
  # chaque fichier ; un transfert manqué fait échouer la commande.
  rclone copy "$SAUVEGARDE_SOURCE_STOCKAGE" "$copie"

  stockage_fichiers=$(find "$copie" -type f | wc -l)
  stockage_octets=$(du -sb "$copie" | cut -f1)
  # Pas de compression : PDF, JPEG et PNG le sont déjà.
  tar -C "$travail" -cf - stockage | chiffrer "$travail/lot/stockage.tar.age"
  rm -rf -- "$copie"
  journal "Stockage : $stockage_fichiers fichiers, $(octets "$stockage_octets")."
}

sauvegarder_configuration() {
  etape="configuration du serveur"
  local -a fichiers chemins=()
  local fichier
  read -r -a fichiers <<<"$SAUVEGARDE_FICHIERS"

  for fichier in "${fichiers[@]}"; do
    [[ -f $fichier ]] || fatal "fichier à joindre introuvable : $fichier"
    chemins+=("${fichier#/}")
  done
  configuration_fichiers=${#chemins[@]}
  if ((configuration_fichiers == 0)); then
    journal "Configuration : aucun fichier à joindre (SAUVEGARDE_FICHIERS vide)."
    return 0
  fi

  tar -C / -cf - "${chemins[@]}" | chiffrer "$travail/lot/configuration.tar.age"
  journal "Configuration : $configuration_fichiers fichiers."
}

ecrire_manifeste() {
  etape="manifeste"
  (cd "$travail/lot" && sha256sum -- *.age >SHA256SUMS)

  # Rien de personnel ici : des comptes, des tailles, des versions, et les clés
  # publiques qui permettent de savoir quelle clé privée ouvre le lot.
  {
    echo "lot=$lot"
    echo "serveur=$(hostname)"
    echo "pg_dump=$pg_version"
    echo "pg_dump_options=${SAUVEGARDE_PG_DUMP_OPTIONS:-}"
    echo "base_tables=$base_tables"
    echo "base_octets_en_clair=$base_octets"
    echo "stockage_source=$SAUVEGARDE_SOURCE_STOCKAGE"
    echo "stockage_fichiers=$stockage_fichiers"
    echo "stockage_octets_en_clair=$stockage_octets"
    echo "configuration_fichiers=$configuration_fichiers"
    grep '^age1' "$SAUVEGARDE_DESTINATAIRES" | sed 's/^/cle_publique=/'
    echo "termine=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$travail/lot/manifeste.txt"
}

envoyer() {
  etape="envoi"
  local cible=$SAUVEGARDE_DESTINATION/$lot
  envoi_commence=1

  rclone copy "$travail/lot" "$cible" --exclude manifeste.txt
  # Relecture de ce qui est arrivé : tailles et empreintes, fichier par fichier.
  rclone check "$travail/lot" "$cible" --one-way --exclude manifeste.txt
  # Le manifeste en dernier : un lot sans manifeste est un lot incomplet.
  rclone copyto "$travail/lot/manifeste.txt" "$cible/manifeste.txt"

  envoi_commence=
  journal "Envoi : lot complet et vérifié sur $cible."
}

appliquer_retention() {
  etape="rétention"
  local ancien effaces=0
  {
    rclone lsf --dirs-only "$SAUVEGARDE_DESTINATION" | sed 's:/$::'
  } >"$travail/tous"
  {
    rclone lsf -R --files-only --include '/*/manifeste.txt' "$SAUVEGARDE_DESTINATION" |
      sed 's:/manifeste\.txt$::'
  } >"$travail/complets"

  lots_a_effacer "$lot" "$travail/tous" "$travail/complets" \
    "$SAUVEGARDE_GARDER_QUOTIDIENNES" "$SAUVEGARDE_GARDER_HEBDOMADAIRES" \
    "$SAUVEGARDE_GARDER_MENSUELLES" >"$travail/effacer"

  while IFS= read -r ancien; do
    rclone purge "$SAUVEGARDE_DESTINATION/$ancien"
    journal "Rétention : lot $ancien effacé."
    effaces=$((effaces + 1))
  done <"$travail/effacer"

  journal "Rétention : $(($(wc -l <"$travail/complets") - effaces)) lots complets conservés, $effaces effacés."
}

principal() {
  set -Eeuo pipefail
  umask 077

  JOURNAL=${SAUVEGARDE_JOURNAL:-$HOME/centre-affaires/sauvegardes.log}
  mkdir -p -- "$(dirname -- "$JOURNAL")"
  # Tout ce qui s'écrit, y compris les erreurs de pg_dump et de rclone, va au
  # journal en plus de la sortie standard.
  exec 3> >(tee -a -- "$JOURNAL")
  exec 1>&3 2>&3
  journal_fd=3

  trap 'echec $? $LINENO "$BASH_COMMAND"' ERR
  trap nettoyer EXIT

  charger_configuration
  verifier_outils
  verrouiller

  lot=$(date -u +%Y-%m-%dT%H%M%SZ)
  local debut
  debut=$(date +%s)
  travail=$(mktemp -d "$SAUVEGARDE_TRAVAIL/centre-affaires-sauvegarde.XXXXXX")
  mkdir -- "$travail/lot"
  journal "Lot $lot : début."

  sauvegarder_base
  sauvegarder_stockage
  sauvegarder_configuration
  ecrire_manifeste
  envoyer
  appliquer_retention

  journal "Lot $lot : terminé en $(($(date +%s) - debut)) s."
  signaler ""
}

# Chargé par `source` (les tests), le script ne fait que définir ses fonctions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  principal "$@"
fi
