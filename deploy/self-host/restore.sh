#!/usr/bin/env bash
# Puts a ./backup.sh archive back, replacing what is there: ./restore.sh <archive>
# Run it with the same or a newer image than made the archive (see manifest.txt in it): an older one has not seen a newer schema.
set -euo pipefail
cd "$(dirname "$0")"
archive=${1:?usage: restore.sh <archive>}
archive=$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -C "$tmp" -xzf "$archive" db.dump files.tar manifest.txt
cat "$tmp/manifest.txt"
docker compose up -d db
docker compose stop app
docker compose exec -T db pg_restore -U rsva -d rsva --clean --if-exists --no-owner <"$tmp/db.dump"
docker compose run --rm -T --no-deps --entrypoint sh app -c 'find /data/files -mindepth 1 -delete && tar -xf - -C /data/files' <"$tmp/files.tar"
docker compose up -d app
echo "restored from $archive"
