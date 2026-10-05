#!/usr/bin/env bash
# Wake the Meeting Librarian: "meeting artifacts may have changed".
# Sends an HMAC-signed, content-free webhook to the Paperclip routine trigger.
# Called by the systemd user path unit; safe to run repeatedly.
set -euo pipefail

secrets="${PENNYWORTH_SECRETS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/pennyworth}"
url_file="$secrets/meeting_webhook_url"
secret_file="$secrets/meeting_webhook_secret"
[ -s "$url_file" ] && [ -s "$secret_file" ] || { echo "webhook not configured (run scripts/paperclip-setup.mjs)" >&2; exit 0; }

url="$(cat "$url_file")"
ts="$(date +%s)"
body='{"event":"meeting_artifacts_changed"}'
sig="$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$(cat "$secret_file")" -hex | sed 's/^.*= //')"

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$url" \
  -H 'Content-Type: application/json' \
  -H "X-Paperclip-Timestamp: $ts" \
  -H "X-Paperclip-Signature: sha256=$sig" \
  --data "$body" || true)"
case "$code" in
  202|409) exit 0 ;;  # 409 = replay/coalesced: fine
  *) echo "meeting scan trigger failed: HTTP $code" >&2; exit 1 ;;
esac
