#!/usr/bin/env bash
# The first workspace and its owner: ./bootstrap.sh <slug> <owner-email> [workspace name]
# A server with no workspaces has nobody who can sign in (accounts come from workspaces and invites), so the first one is
# made from the server's shell, by importing a bundle (packages/schema/src/bundle.ts) with one project, "APP". The owner
# then signs in with a code at the app's address; the code is in `docker compose logs app` unless a mail provider is set.
set -euo pipefail
cd "$(dirname "$0")"
slug=${1:?usage: bootstrap.sh <slug> <owner-email> [workspace name]}
email=${2:?usage: bootstrap.sh <slug> <owner-email> [workspace name]}
name=${3:-$slug}
[[ $slug =~ ^[a-z0-9-]{3,32}$ ]] || { echo "slug: 3 to 32 lower-case letters, digits and hyphens" >&2; exit 2; }
[[ $email =~ ^[^[:space:]\"\\]+@[^[:space:]\"\\]+$ ]] || { echo "owner-email is not an address" >&2; exit 2; }
[[ $name != *[\"\\]* ]] || { echo "the name has no quotes or backslashes" >&2; exit 2; }
state() { echo "{\"m\":\"State\",\"ext\":\"$1\",\"project\":{\"ext\":\"p\"},\"name\":\"$2\",\"group\":\"$3\",\"color\":\"$4\",\"position\":$5${6:+,\"isDefault\":true}}"; }
{
  echo "{\"m\":\"Bundle\",\"version\":1,\"source\":\"bootstrap\",\"workspace\":{\"slug\":\"$slug\",\"name\":\"$name\"},\"owner\":{\"ext\":\"owner\"}}"
  echo "{\"m\":\"User\",\"ext\":\"owner\",\"email\":\"$email\",\"name\":\"${email%%@*}\"}"
  echo '{"m":"Project","ext":"p","key":"APP","name":"App"}'
  state s1 Backlog backlog '#a3a3a3' 1 default
  state s2 Todo unstarted '#3b82f6' 2
  state s3 "In Progress" started '#eab308' 3
  state s4 Done completed '#22c55e' 4
  state s5 Canceled cancelled '#ef4444' 5
} | docker compose exec -T app node apps/server/dist/import-cli.js /dev/stdin
