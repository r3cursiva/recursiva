#!/usr/bin/env bash
# The new repository's one commit, built locally and pushed by nobody (RSVA-591): the tree `pnpm public:tree` writes, `docs`
# ignored, committed by the owner under the GitHub noreply address. Run from a checkout of main (the one that gets switched).
#
#   tools/public/first-commit.sh "Owner Name" "12345+login@users.noreply.github.com" [folder]
#
# The folder (default: a new temporary one) is a git repository with that single commit; the script checks it and prints
# the push commands. Run again for a fresh folder; nothing outside the folder changes, so there is no way back to take.
set -euo pipefail

name=${1:?usage: first-commit.sh "Owner Name" "<id>+<login>@users.noreply.github.com" [folder]}
email=${2:?usage: first-commit.sh "Owner Name" "<id>+<login>@users.noreply.github.com" [folder]}
[[ $email =~ ^([0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$ ]] || { echo "not a GitHub noreply address: $email" >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
dir=${3:-$(mktemp -d "${TMPDIR:-/tmp}/rsva-public-first.XXXXXX")}
[ -z "$(ls -A "$dir" 2>/dev/null)" ] || { echo "$dir is not empty" >&2; exit 2; }
[ -z "$(git -C "$root" status --porcelain)" ] || { echo "the checkout has uncommitted changes: the tree is built from what is committed" >&2; exit 2; }

(cd "$root" && pnpm public:check && pnpm public:tree "$dir")
# docs/ is the maintainers' private repository cloned into their copy (tools/public/switch.md); never a file of this one.
printf '\n# The maintainers keep private documents in a separate repository, cloned here.\n/docs\n' >> "$dir/.gitignore"

export GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email
git -C "$dir" init -q -b main
git -C "$dir" add -A
git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "Initial commit"

# Checks: one commit, only the owner's noreply address in it, no assistant attribution, nothing of docs/ or the owner's CLAUDE.md.
[ "$(git -C "$dir" rev-list --count HEAD)" = 1 ] || { echo "FAIL: not one commit" >&2; exit 1; }
[ "$(git -C "$dir" log -1 --format='%ae|%ce')" = "$email|$email" ] || { echo "FAIL: author or committer is not $email" >&2; exit 1; }
if git -C "$dir" log -1 --format=%B | grep -qiE 'claude|co-authored-by|generated with'; then echo "FAIL: attribution in the message" >&2; exit 1; fi
if git -C "$dir" ls-files | grep -E '^docs/' >/dev/null; then echo "FAIL: docs/ is in the tree" >&2; exit 1; fi
if git -C "$dir" ls-files | grep -q 'CLAUDE.public.md'; then echo "FAIL: CLAUDE.public.md was not renamed" >&2; exit 1; fi
if ! command -v gitleaks >/dev/null; then echo "FAIL: gitleaks is not installed (brew install gitleaks)" >&2; exit 1; fi
gitleaks git "$dir" --no-banner --redact --exit-code 1

echo
echo "ok: $(git -C "$dir" ls-files | wc -l | tr -d ' ') files, one commit $(git -C "$dir" rev-parse --short HEAD) by $name <$email> in $dir"
echo "push (after the repository exists, private):"
echo "  git -C $dir remote add origin git@github.com:r3cursiva/recursiva.git && git -C $dir push -u origin main"
