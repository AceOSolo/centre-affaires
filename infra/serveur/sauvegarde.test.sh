#!/usr/bin/env bash
# Tests de sauvegarde.sh (ADR 022) : la règle de rétention, et les refus qui
# doivent arrêter une sauvegarde avant qu'elle ne parte.
#
#   bash infra/serveur/sauvegarde.test.sh
#
# Sans réseau, sans base, sans age ni rclone : seulement bash et GNU coreutils.
# Lancé par la CI.
set -uo pipefail

ici=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=sauvegarde.sh
source "$ici/sauvegarde.sh"

reussis=0
rates=0
ignores=0

attendu() {
  local nom=$1 attendu=$2 obtenu=$3
  if [[ $attendu == "$obtenu" ]]; then
    echo "ok - $nom"
    reussis=$((reussis + 1))
  else
    echo "ÉCHEC - $nom"
    diff <(printf '%s\n' "$attendu") <(printf '%s\n' "$obtenu") | sed 's/^/    /'
    rates=$((rates + 1))
  fi
}

# Un lot par jour à 2 h 30, du jour $1 au jour $2 compris.
lots_quotidiens() {
  local jour=$1
  while [[ ! $jour > $2 ]]; do
    echo "${jour}T023000Z"
    jour=$(date -u -d "$jour + 1 day" +%F)
  done
}

lignes() { printf '%s\n' "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# --- Rétention -------------------------------------------------------------

attendu "quotidienne : le lot de chacun des 7 derniers jours" \
  "$(lignes 2026-10-01T023000Z 2026-09-30T023000Z 2026-09-29T023000Z 2026-09-28T023000Z \
    2026-09-27T023000Z 2026-09-26T023000Z 2026-09-25T023000Z)" \
  "$(lots_quotidiens 2026-09-01 2026-10-01 | lots_a_garder 7 0 0)"

attendu "quotidienne : un seul lot par jour, le plus récent" \
  "$(lignes 2026-10-01T101500Z 2026-09-30T023000Z)" \
  "$(lignes 2026-09-29T023000Z 2026-10-01T023000Z 2026-09-30T023000Z 2026-10-01T101500Z |
    lots_a_garder 2 0 0)"

# Le 01/10/2026 est un jeudi (semaine 40) ; les semaines 37 à 39 finissent
# les dimanches 13, 20 et 27 septembre.
attendu "hebdomadaire : le dernier lot de chacune des 4 dernières semaines ISO" \
  "$(lignes 2026-10-01T023000Z 2026-09-27T023000Z 2026-09-20T023000Z 2026-09-13T023000Z)" \
  "$(lots_quotidiens 2026-09-01 2026-10-01 | lots_a_garder 1 4 0)"

attendu "7 quotidiennes, 4 hebdomadaires, 12 mensuelles sur 400 jours : 19 lots" \
  "$(lignes 2026-10-01T023000Z 2026-09-30T023000Z 2026-09-29T023000Z 2026-09-28T023000Z \
    2026-09-27T023000Z 2026-09-26T023000Z 2026-09-25T023000Z \
    2026-09-20T023000Z 2026-09-13T023000Z \
    2026-08-31T023000Z 2026-07-31T023000Z 2026-06-30T023000Z 2026-05-31T023000Z \
    2026-04-30T023000Z 2026-03-31T023000Z 2026-02-28T023000Z 2026-01-31T023000Z \
    2025-12-31T023000Z 2025-11-30T023000Z)" \
  "$(lots_quotidiens 2025-08-28 2026-10-01 | lots_a_garder 7 4 12)"

attendu "mensuelle : un trou de plusieurs mois ne compte pas comme des mois" \
  "$(lignes 2026-10-01T023000Z 2026-03-15T023000Z 2025-11-02T023000Z)" \
  "$(lignes 2025-10-31T023000Z 2025-11-02T023000Z 2026-03-15T023000Z 2026-10-01T023000Z |
    lots_a_garder 1 0 3)"

attendu "les noms qui ne sont pas des lots sont ignorés" \
  "2026-10-01T023000Z" \
  "$(lignes notes 2026-13-01T023000Z 2026-10-01T023000Z.tmp '' 2026-10-01T023000Z |
    lots_a_garder 7 4 12)"

lignes 2026-09-28T023000Z 2026-09-29T023000Z 2026-09-30T023000Z \
  2026-10-01T023000Z 2026-10-01T090000Z divers >"$tmp/tous"
lignes 2026-09-28T023000Z 2026-09-30T023000Z 2026-10-01T023000Z >"$tmp/complets"
attendu "effacement : lots complets hors rétention et restes plus anciens que le lot courant" \
  "$(lignes 2026-09-28T023000Z 2026-09-29T023000Z)" \
  "$(lots_a_effacer 2026-10-01T023000Z "$tmp/tous" "$tmp/complets" 2 0 0)"

lignes 2026-10-01T023000Z 2026-10-01T090000Z >"$tmp/tous"
cp "$tmp/tous" "$tmp/complets"
attendu "effacement : le lot courant n'est jamais effacé" \
  "" \
  "$(lots_a_effacer 2026-10-01T023000Z "$tmp/tous" "$tmp/complets" 1 0 0)"

# --- Refus -----------------------------------------------------------------

# Lance le script avec la configuration $1 ; rend « code|dernière ligne du journal ».
lancer() {
  local journal=$tmp/journal.log
  rm -f -- "$journal"
  SAUVEGARDE_CONFIG=$1 SAUVEGARDE_JOURNAL=$journal bash "$ici/sauvegarde.sh" >/dev/null 2>&1
  local code=$?
  printf '%s|%s' "$((code != 0))" "$(tail -n 1 "$journal" 2>/dev/null | cut -d' ' -f2-)"
}

attendu "sans configuration : échec journalisé" \
  "1|ÉCHEC, étape « configuration » : configuration illisible : $tmp/absente.env (modèle : infra/serveur/sauvegarde.env.example)" \
  "$(lancer "$tmp/absente.env")"

configuration() {
  cat >"$tmp/sauvegarde.env" <<EOF
PGHOST=localhost
PGDATABASE=neondb
PGUSER=sauvegarde
SAUVEGARDE_SOURCE_STOCKAGE=stockage:uploads
SAUVEGARDE_DESTINATION=$1
SAUVEGARDE_DESTINATAIRES=$tmp/destinataires.txt
EOF
  chmod 600 "$tmp/sauvegarde.env"
}

configuration horssite:sauvegardes
if [[ $(stat -c %a "$tmp/sauvegarde.env") != 600 ]]; then
  # Système de fichiers sans droits POSIX (Git Bash sous Windows) : le script
  # y refuse toute configuration. Ces cas tournent en CI, sous Linux.
  echo "ignoré - refus de configuration : droits POSIX indisponibles ici"
  ignores=3
else
  attendu "configuration lisible par d'autres comptes : refusée" \
    "1|ÉCHEC, étape « configuration » : droits 644 sur $tmp/sauvegarde.env : chmod 600 attendu" \
    "$(chmod 644 "$tmp/sauvegarde.env" && lancer "$tmp/sauvegarde.env")"

  configuration horssite:sauvegardes
  printf '# clé de test\nAGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n' \
    >"$tmp/destinataires.txt"
  attendu "clé privée sur le serveur : refusée" \
    "1|ÉCHEC, étape « configuration » : $tmp/destinataires.txt contient une clé privée age : elle n'a rien à faire sur le serveur" \
    "$(lancer "$tmp/sauvegarde.env")"

  configuration /var/backups/centre-affaires
  attendu "destination locale : refusée, la copie doit quitter le serveur" \
    "1|ÉCHEC, étape « configuration » : SAUVEGARDE_DESTINATION doit désigner un emplacement distant rclone (« nom:chemin »)" \
    "$(lancer "$tmp/sauvegarde.env")"
fi

echo
echo "$reussis réussis, $rates en échec, $ignores ignorés."
((rates == 0))
