#!/usr/bin/env bash
# GitHub settings of the public repository (RSVA-536), through `gh api`. Idempotent: run again after any change.
#
#   tools/public/github-settings.sh                      dry run: prints each call, changes nothing
#   tools/public/github-settings.sh --apply              makes the calls
#   REPO=owner/name tools/public/github-settings.sh ...  another repository (default r3cursiva/recursiva)
#   tools/public/github-settings.sh --check              reads the settings back (no change), exit 1 on a difference
#
# The organization is on the free plan (checked 2026-11-10): rulesets, secret scanning and push protection need the
# repository to be public, and GitHub answers 403/422 "Upgrade to GitHub Pro or make this repository public" while it is
# private. Those steps print SKIPPED; run the script again right after the repository is made public. Dependabot alerts,
# security updates, private vulnerability reporting, Discussions, topics and the description work on a private one.
#
# The CI check is required, and it can be: since RSVA-534 the `check` job is skipped (if:) on the owner's own branches,
# and a skipped job reports Success, so it does not block them (docs.github.com, "Control jobs with conditions"); a fork's
# pull request runs it for real. Required approvals are 0: a single maintainer cannot approve their own pull request.
# Endpoints, checked against github/rest-api-description on 2026-11-10: PATCH /repos/{o}/{r}; PUT .../vulnerability-alerts,
# .../automated-security-fixes, .../private-vulnerability-reporting, .../topics, .../actions/permissions/workflow and
# .../fork-pr-contributor-approval; GET/POST/PUT .../rulesets; GraphQL
# updateRepository(hasDiscussionsEnabled), the REST update has no field for Discussions.
set -uo pipefail

REPO=${REPO:-r3cursiva/recursiva}
MODE=dry
case "${1:-}" in
  ""|--dry-run) ;;
  --apply) MODE=apply ;;
  --check) MODE=check ;;
  *) echo "usage: $0 [--dry-run | --apply | --check]" >&2; exit 2 ;;
esac

DESCRIPTION="Local-first task tracker for people and agents, Linear-style sync"
HOMEPAGE="https://rsva.dev"
TOPICS='["issue-tracker","task-management","project-management","local-first","sync-engine","ai-agents","typescript","postgresql","self-hosted"]'
RULESET='{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "required_status_checks": [ { "context": "check" } ], "strict_required_status_checks_policy": false } }
  ]
}'
SECURITY='{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
REPO_FIELDS=$(printf '{"description":"%s","homepage":"%s","default_branch":"main","has_issues":true,"has_wiki":false,"has_projects":false,"delete_branch_on_merge":true}' "$DESCRIPTION" "$HOMEPAGE")

failed=0
# step <title> <gh api arguments...>: prints the call; in --apply makes it. Plan limits are SKIPPED, anything else FAILED.
step() {
  local title=$1; shift
  if [ "$MODE" = dry ]; then echo "would: $title"; echo "       gh api $*"; [ -n "${BODY:-}" ] && echo "       $BODY" | tr -s ' \n' ' ' | sed 's/$/\n/'; return; fi
  local out
  if out=$(gh api "$@" 2>&1); then echo "ok:      $title"; return; fi
  if grep -qiE "upgrade to github|make this repository public|secret protection|advanced security|not available" <<<"$out"; then
    echo "SKIPPED: $title (needs a public repository or a paid plan; run again after it is public)"
  else
    echo "FAILED:  $title: $(head -c 300 <<<"$out")"; failed=1
  fi
}

# check <title> <jq expression that prints true or false> <gh api arguments...>
differ=0
check() {
  local title=$1 expr=$2; shift 2
  local got
  got=$(gh api "$@" --jq "$expr" 2>&1) || got="error: $(head -c 120 <<<"$got")"
  if [ "$got" = true ]; then echo "ok:      $title"; else echo "DIFFERS: $title ($got)"; differ=1; fi
}

if [ "$MODE" = check ]; then
  check "description, homepage, default branch, wiki/projects off, issues on" \
    ".description == \"$DESCRIPTION\" and .homepage == \"$HOMEPAGE\" and .default_branch == \"main\" and .has_wiki == false and .has_projects == false and .has_issues == true" "repos/$REPO"
  check "secret scanning and push protection" '.security_and_analysis.secret_scanning.status == "enabled" and .security_and_analysis.secret_scanning_push_protection.status == "enabled"' "repos/$REPO"
  check "Dependabot security updates" '.security_and_analysis.dependabot_security_updates.status == "enabled"' "repos/$REPO"
  check "Discussions" '.has_discussions == true' "repos/$REPO"
  check "private vulnerability reporting" '.enabled == true' "repos/$REPO/private-vulnerability-reporting"
  check "Actions: outside contributors need approval" '.approval_policy == "all_external_contributors"' "repos/$REPO/actions/permissions/fork-pr-contributor-approval"
  check "Actions: read-only default token" '.default_workflow_permissions == "read" and .can_approve_pull_request_reviews == false' "repos/$REPO/actions/permissions/workflow"
  check "topics" "(.names | sort) == ($TOPICS | sort)" "repos/$REPO/topics"
  check "ruleset on main: no deletion, no force push, pull request, check required" \
    '[.[] | select(.name == "main" and .enforcement == "active")] | length == 1' "repos/$REPO/rulesets"
  gh api "repos/$REPO/vulnerability-alerts" -i 2>&1 | head -1 | grep -q " 204" && echo "ok:      Dependabot alerts" || { echo "DIFFERS: Dependabot alerts"; differ=1; }
  exit $differ
fi

[ "$MODE" = dry ] && echo "dry run for $REPO (add --apply to make the calls)"
BODY=$REPO_FIELDS step "description, homepage, default branch main, wiki and projects off, issues on, delete merged branches" -X PATCH "repos/$REPO" --input - <<<"$REPO_FIELDS"
BODY=$SECURITY step "secret scanning and push protection" -X PATCH "repos/$REPO" --input - <<<"$SECURITY"
step "Dependabot alerts" -X PUT "repos/$REPO/vulnerability-alerts"
step "Dependabot security updates" -X PUT "repos/$REPO/automated-security-fixes"
step "private vulnerability reporting" -X PUT "repos/$REPO/private-vulnerability-reporting"
BODY="{\"names\":$TOPICS}" BODY='{"approval_policy":"all_external_contributors"}' step "Actions: every outside contributor's pull request waits for approval (public repositories only)" -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --input - <<<'{"approval_policy":"all_external_contributors"}'
BODY='{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}' step "Actions: the default token is read-only and cannot approve pull requests" -X PUT "repos/$REPO/actions/permissions/workflow" --input - <<<'{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
step "topics" -X PUT "repos/$REPO/topics" --input - <<<"{\"names\":$TOPICS}"

# Discussions: GraphQL only.
if [ "$MODE" = dry ]; then
  echo "would: Discussions on"; echo "       gh api graphql -f query='mutation(\$id:ID!){updateRepository(input:{repositoryId:\$id,hasDiscussionsEnabled:true}){clientMutationId}}' -f id=<node id of $REPO>"
else
  id=$(gh api "repos/$REPO" --jq .node_id 2>&1) || { echo "FAILED:  cannot read $REPO: $id"; exit 1; }
  step "Discussions on" graphql -f query='mutation($id:ID!){updateRepository(input:{repositoryId:$id,hasDiscussionsEnabled:true}){clientMutationId}}' -f id="$id"
fi

# The ruleset: updated in place when one named main exists, else created.
if [ "$MODE" = dry ]; then
  echo "would: ruleset 'main' (no deletion, no force push, pull request required with 0 approvals, check 'check' required)"
  echo "       gh api -X POST|PUT repos/$REPO/rulesets[/<id of the ruleset named main>] --input -"; echo "       $RULESET" | tr -s ' \n' ' ' | sed 's/$/\n/' 
else
  existing=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "main") | .id' 2>&1)
  if grep -qiE "upgrade to github|make this repository public" <<<"$existing"; then
    echo "SKIPPED: ruleset on main (needs a public repository or a paid plan; run again after it is public)"
  elif [ -n "$existing" ] && ! [[ $existing =~ ^[0-9]+$ ]]; then
    echo "FAILED:  ruleset on main: $existing"; failed=1
  elif [ -n "$existing" ]; then
    step "ruleset on main (updated)" -X PUT "repos/$REPO/rulesets/$existing" --input - <<<"$RULESET"
  else
    step "ruleset on main (created)" -X POST "repos/$REPO/rulesets" --input - <<<"$RULESET"
  fi
fi
[ "$MODE" = apply ] && echo "done, $([ $failed = 0 ] && echo 'no failures' || echo 'with failures'); tools/public/github-settings.sh --check reads it back"
exit $failed
