#!/usr/bin/env bash
# Idempotent Cloudflare provisioning for the STITCH exhibition site.
#
# Creates, or reuses, a named tunnel; points its ingress at the nginx container;
# upserts a proxied CNAME for the apex and for www; and writes the tunnel token
# into the env file. Every step is lookup-then-upsert, so it is safe to re-run.
#
# Reads the account credentials from the grounding repo's shared env:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# The zone is looked up by name rather than by a stored id, because this zone is
# used by exactly one project and does not earn a variable in shared.env.
# Token needs: Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit.
set -euo pipefail
cd "$(dirname "$0")/.."

SHARED="${SHARED_ENV:-$HOME/unified-workspace/env/shared.env}"
ENV_FILE="${ENV_FILE:-.env}"
[[ -f "$SHARED" ]] || { echo "missing $SHARED" >&2; exit 1; }
set -a; source "$SHARED"; set +a
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"

TUNNEL_NAME="${TUNNEL_NAME:-stitch-exhibition}"
ZONE_NAME="${ZONE_NAME:-stitchexhibition.com}"
ORIGIN="${ORIGIN:-http://web:80}"
HOSTS=("$ZONE_NAME" "www.$ZONE_NAME")

API="https://api.cloudflare.com/client/v4"
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
ACCT="$API/accounts/$CLOUDFLARE_ACCOUNT_ID"

jqf() { python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("success"):
    sys.exit("  API error: " + json.dumps(d.get("errors")))
r = d.get("result")
for k in sys.argv[1:]:
    if r is None: break
    r = r.get(k) if isinstance(r, dict) else r
print(r if r is not None else "")' "$@"; }

first_id() { python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("success"): sys.exit("  API error: " + json.dumps(d.get("errors")))
print((d.get("result") or [{}])[0].get("id", "") if d.get("result") else "")'; }

echo "== zone: $ZONE_NAME =="
ZONE_ID=$(curl -s -H "$AUTH" "$API/zones?name=$ZONE_NAME" | first_id)
[[ -n "$ZONE_ID" ]] || { echo "  zone not found on this account" >&2; exit 1; }
ZONE="$API/zones/$ZONE_ID"
echo "  id: $ZONE_ID"

echo "== tunnel: $TUNNEL_NAME =="
TUNNEL_ID=$(curl -s -H "$AUTH" "$ACCT/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | first_id)
if [[ -z "$TUNNEL_ID" ]]; then
  echo "  creating (remotely-managed config)"
  TUNNEL_ID=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    "$ACCT/cfd_tunnel" --data "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}" | jqf id)
else
  echo "  exists, reusing"
fi
echo "  id: $TUNNEL_ID"

echo "== ingress =="
INGRESS=$(python3 -c '
import json, sys
origin = sys.argv[1]
rules = [{"hostname": h, "service": origin} for h in sys.argv[2:]]
rules.append({"service": "http_status:404"})
print(json.dumps({"config": {"ingress": rules}}))' "$ORIGIN" "${HOSTS[@]}")
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  "$ACCT/cfd_tunnel/$TUNNEL_ID/configurations" --data "$INGRESS" | jqf >/dev/null
for h in "${HOSTS[@]}"; do echo "  $h -> $ORIGIN"; done

echo "== DNS (proxied CNAME -> $TUNNEL_ID.cfargotunnel.com) =="
for FQDN in "${HOSTS[@]}"; do
  REC_ID=$(curl -s -H "$AUTH" "$ZONE/dns_records?name=$FQDN&type=CNAME" | first_id)
  BODY="{\"type\":\"CNAME\",\"name\":\"$FQDN\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1,\"comment\":\"stitch-exhibition tunnel\"}"
  if [[ -z "$REC_ID" ]]; then
    curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$ZONE/dns_records" --data "$BODY" | jqf >/dev/null
    echo "  created $FQDN"
  else
    curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' "$ZONE/dns_records/$REC_ID" --data "$BODY" | jqf >/dev/null
    echo "  updated $FQDN"
  fi
done

echo "== writing CLOUDFLARE_TUNNEL_TOKEN into $ENV_FILE =="
TOKEN=$(curl -s -H "$AUTH" "$ACCT/cfd_tunnel/$TUNNEL_ID/token" | jqf)
[[ -n "$TOKEN" ]] || { echo "  failed to fetch tunnel token" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || cp .env.example "$ENV_FILE"
if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=' "$ENV_FILE"; then
  python3 - "$ENV_FILE" "$TOKEN" <<'PY'
import sys
path, token = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
open(path, "w").write("\n".join(
    f"CLOUDFLARE_TUNNEL_TOKEN={token}" if l.startswith("CLOUDFLARE_TUNNEL_TOKEN=") else l for l in lines) + "\n")
PY
else
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
echo "  OK"
echo
echo "Public URL: https://$ZONE_NAME"
