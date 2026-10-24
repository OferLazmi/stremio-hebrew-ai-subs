#!/usr/bin/env bash
# Scripted deploy to Cloudflare Workers (Free plan is enough).
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN   API token with: Workers Scripts:Edit, Workers KV Storage:Edit (account scope)
#   CLOUDFLARE_ACCOUNT_ID  your Cloudflare account id
#   GEMINI_API_KEY         Google AI Studio key (stored as a Worker secret)
#   ACCESS_TOKEN           private token that goes in the addon URL (>= 16 chars of A-Z a-z 0-9 _ -),
#                          generate one with:  openssl rand -hex 24
# Optional:
#   KV_NAMESPACE_TITLE     default: stremio-ai-subs-cache
#   DRY_RUN=1              validate inputs + bundle the Worker locally; make NO Cloudflare API calls
set -euo pipefail
cd "$(dirname "$0")"

KV_TITLE="${KV_NAMESPACE_TITLE:-stremio-ai-subs-cache}"
API="https://api.cloudflare.com/client/v4"
GEN=wrangler.generated.toml
SECRETS=.deploy-secrets.json

die() { echo "ERROR: $*" >&2; exit 1; }
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GEMINI_API_KEY ACCESS_TOKEN; do
  [ -n "${!v:-}" ] || die "$v is not set (see the header of deploy.sh)"
done
[[ "$ACCESS_TOKEN" =~ ^[A-Za-z0-9_-]{16,}$ ]] || die "ACCESS_TOKEN must be >= 16 chars of [A-Za-z0-9_-] (try: openssl rand -hex 24)"
command -v node >/dev/null || die "node (>= 20) is required"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

echo "==> Installing dependencies"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "==> DRY RUN: bundling only (no Cloudflare calls)"
  npx tsc -p .
  npx wrangler deploy --dry-run --outdir .wrangler/dryrun-bundle
  echo "Dry run OK."
  exit 0
fi

cf() { # cf METHOD PATH [json-body]  -> prints JSON, fails on success=false
  local out
  out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" ${3:+--data "$3"})
  echo "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.success){console.error("Cloudflare API error:",JSON.stringify(j.errors));process.exit(1)}console.log(d)})'
}
jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")})' "$1"; }

echo "==> Checking API token"
cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" > .subdomain.json || die "token cannot read the account (check CLOUDFLARE_ACCOUNT_ID and token permissions)"
SUBDOMAIN=$(jget result.subdomain < .subdomain.json); rm -f .subdomain.json
[ -n "$SUBDOMAIN" ] || die "this account has no workers.dev subdomain yet. Open https://dash.cloudflare.com -> Workers & Pages once (it asks you to pick a subdomain), then re-run."

echo "==> KV namespace '$KV_TITLE'"
cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" > .kv.json
KV_ID=$(node -e 'const j=require("./.kv.json");const n=j.result.find(x=>x.title===process.argv[1]);console.log(n?n.id:"")' "$KV_TITLE"); rm -f .kv.json
if [ -z "$KV_ID" ]; then
  KV_ID=$(cf POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces" "{\"title\":\"$KV_TITLE\"}" | jget result.id)
  echo "    created: $KV_ID"
else
  echo "    exists:  $KV_ID"
fi
[ -n "$KV_ID" ] || die "could not determine KV namespace id"

echo "==> Writing $GEN (wrangler.toml + KV id)"
sed "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml > "$GEN"

echo "==> Deploying Worker"
npx wrangler deploy --config "$GEN"

echo "==> Setting secrets (ACCESS_TOKEN, GEMINI_API_KEY)"
umask 077
trap 'rm -f "$SECRETS"' EXIT
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({ACCESS_TOKEN:process.env.ACCESS_TOKEN,GEMINI_API_KEY:process.env.GEMINI_API_KEY}))' "$SECRETS"
npx wrangler secret bulk "$SECRETS" --config "$GEN"

NAME=$(sed -n 's/^name *= *"\(.*\)"/\1/p' wrangler.toml | head -1)
HOST="$NAME.$SUBDOMAIN.workers.dev"
echo "==> Smoke test"
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/$ACCESS_TOKEN/manifest.json" || true)
bad=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/wrong-token/manifest.json" || true)
echo "    manifest with token: HTTP $code (expect 200); wrong token: HTTP $bad (expect 404)"

cat <<MSG

Deployed.
  Install in Stremio (desktop/phone/TV, same account):  stremio://$HOST/$ACCESS_TOKEN/manifest.json
  Or paste this into Stremio's Addons search box:        https://$HOST/$ACCESS_TOKEN/manifest.json
Keep the URL private: anyone with it can use your Gemini quota.
MSG
