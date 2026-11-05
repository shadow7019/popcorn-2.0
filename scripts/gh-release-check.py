#!/usr/bin/env python3
"""Check popcorn-2.0 CI runs + release asset freshness/ digests."""
import json, os, sys, urllib.request

REPO = "shadow7019/popcorn-2.0"
TOKEN = os.environ["GH_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}

def api(path):
    req = urllib.request.Request(f"https://api.github.com{path}", headers=H)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

print("=== latest workflow runs (build-apps) ===")
runs = api(f"/repos/{REPO}/actions/workflows/build-apps.yml/runs?per_page=5")
for r in runs.get("workflow_runs", []):
    print(f'{r["id"]}  {r["run_started_at"]}  {r["status"]}/{r["conclusion"]}  head={r["head_sha"][:7]}  {r["display_title"][:60]}')

print("\n=== release v1.0.0 assets ===")
rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")
print("release updated_at:", rel["updated_at"], "| draft:", rel["draft"])
for a in rel["assets"]:
    print(f'{a["name"]}  size={a["size"]}  updated={a["updated_at"]}  digest={a.get("digest","<none>")}')
