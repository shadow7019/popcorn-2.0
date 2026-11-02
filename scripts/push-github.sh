#!/usr/bin/env bash
# Push the sandbox project (local branch `main`, the Popcorn Time rebrand) to
# https://github.com/shadow7019/OTAMA as a NEW branch `popcorn-time`.
# NEVER force-pushes and NEVER touches origin/main or its tags — the remote
# main is an unrelated (older, desktop-era) history and must not be clobbered.
#
# Usage:
#   bash scripts/push-github.sh                 # SSH deploy-key path
#   bash scripts/push-github.sh --token <PAT>   # HTTPS fine-grained PAT path
#
# One-time setup for the SSH path: .ssh-deploy/id_otama.pub is the OTAMA-only
# deploy key (Settings → Deploy keys → "Allow write access" MUST be ticked).
# GitHub allows a deploy key on one repo only, so OTAMA gets its own key —
# id_ed25519 stays registered on popcorn-2.0. If instead the key is added at
# ACCOUNT level, either key works and the id_otama override is simply unused.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"
REMOTE_BRANCH="popcorn-time"

if [ "${1:-}" = "--token" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --token <PAT>" >&2; exit 1; }
  git push "https://x-access-token:${2}@github.com/shadow7019/OTAMA.git" \
    "main:refs/heads/${REMOTE_BRANCH}"
else
  # No ssh binary exists in this sandbox; git uses the paramiko transport
  # wrapper. Prefer the dedicated OTAMA key when it exists.
  KEY="$PROJECT/.ssh-deploy/id_ed25519"
  [ -f "$PROJECT/.ssh-deploy/id_otama" ] && KEY="$PROJECT/.ssh-deploy/id_otama"
  GIT_SSH_COMMAND="python3 $PROJECT/scripts/git-ssh-paramiko.py" \
    GIT_SSH_KEY="$KEY" \
    git push "git@github.com:shadow7019/OTAMA.git" \
      "main:refs/heads/${REMOTE_BRANCH}" v1.0.0
fi
