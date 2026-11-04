#!/usr/bin/env bash
# Poll GitHub Actions run jobs until the run completes; print per-job status.
# Usage: GH_TOKEN=<pat> bash scripts/ci-poll.sh [RUN_ID]
set -u
TOKEN="${GH_TOKEN:?export GH_TOKEN=<github pat>}"
REPO="shadow7019/popcorn-2.0"
RUN_ID="${1:-41823882085}"
while true; do
  curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID" -o /tmp/run-status.json
  st=$(python3 -c "import json;print(json.load(open('/tmp/run-status.json')).get('status',''))")
  curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=10" -o /tmp/run-jobs.json
  python3 -c "
import json
for j in json.load(open('/tmp/run-jobs.json')).get('jobs',[]):
    print(f\"  {j['name'][:38]:40} {j['status']:10} {j['conclusion'] or ''}\")"
  echo "-- run: $st"
  [ "$st" = "completed" ] && break
  sleep 60
done
python3 -c "import json;d=json.load(open('/tmp/run-status.json'));print('CONCLUSION:', d.get('conclusion'))"
