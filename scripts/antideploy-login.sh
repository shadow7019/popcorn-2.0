#!/usr/bin/env bash
# Re-bootstrap Antideploy CLI auth after a sandbox recycle (~/.antideploy was
# wiped). Runs the OAuth device flow: mint a code, wait for the user to
# approve it at the verification URL, write the token to ~/.antideploy/
# config.json (mode 0600). Re-mints automatically if a code expires.
# Never prints the token.
set -u
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$HOME/.antideploy/config.json"

mint_code() {
  local resp
  resp=$(curl -sS -m 20 -X POST https://antideploy.com/api/v1/device/code -H 'Content-Type: application/json' -d '{}')
  printf '%s' "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
open('/tmp/adi-device-code', 'w').write(d['deviceCode'])
print('APPROVE:', d.get('verificationUriComplete') or d.get('verificationUri'))
print('CODE:', d.get('userCode'), '(expires in', d.get('expiresIn', 900)//60, 'min)')"
}

echo "Waiting for approval…"
while true; do
  if [ ! -s /tmp/adi-device-code ]; then mint_code; fi
  if bash "$PROJECT_DIR/scripts/antideploy-poll.sh" 5; then
    echo "AUTH OK — you can run scripts/deploy.sh now"
    exit 0
  fi
  # poll failed: code expired (or not approved in time) — mint a fresh one
  rm -f /tmp/adi-device-code
  echo "Code expired — minting a new one…"
  mint_code
done
