#!/usr/bin/env bash
# One archive with everything: ./backup.sh [directory]   (default ./backups, file recursiva-<UTC time>.tar.gz)
# Holds db.dump (pg_dump, custom format), files.tar (uploads), manifest.txt (which image and Postgres made it).
# It does not hold .env: keep that file yourself, the archive is no secret store. The app keeps running.
set -euo pipefail
cd "$(dirname "$0")"
out=${1:-backups}
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
docker compose exec -T db pg_dump -U rsva -Fc rsva >"$tmp/db.dump"
docker compose exec -T app tar -C /data/files -cf - . >"$tmp/files.tar"
{
  echo "created: $(date -u +%FT%TZ)"
  echo "image: $(docker compose ps -q app | xargs docker inspect --format '{{.Config.Image}} {{.Image}}')"
  echo "postgres: $(docker compose exec -T db postgres --version)"
  echo "migrations: $(docker compose exec -T db psql -U rsva -Atc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo unknown)"
} >"$tmp/manifest.txt"
file="$out/recursiva-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$tmp" -czf "$file" db.dump files.tar manifest.txt
chmod 600 "$file"
echo "$file"
