#!/usr/bin/env python3
"""Show job-level outcome of the last two build-apps runs."""
import json, os, urllib.request

REPO = "shadow7019/popcorn-2.0"
TOKEN = os.environ["GH_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}

def api(path):
    req = urllib.request.Request(f"https://api.github.com{path}", headers=H)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

for run_id in (41824878221, 41823882085):
    print(f"=== run {run_id} ===")
    data = api(f"/repos/{REPO}/actions/runs/{run_id}/jobs")
    for j in data["jobs"]:
        print(f'  {j["name"]}: {j["status"]}/{j["conclusion"]}  started={j["started_at"]}  finished={j["completed_at"]}')
        if j["conclusion"] not in ("success", "skipped", None):
            for s in j["steps"]:
                if s["conclusion"] not in ("success", "skipped", None):
                    print(f'      failed step: {s["name"]} -> {s["conclusion"]}')
