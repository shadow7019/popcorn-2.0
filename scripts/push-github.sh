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
# One-time setup for the SSH path: the .ssh-deploy/id_ed25519.pub key is
# registered on the shadow7019 GitHub account (Settings → SSH keys), which
# authorizes it for every repo under the account, OTAMA included.
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
  # wrapper (same one push-popcorn2.sh uses).
  GIT_SSH_COMMAND="python3 $PROJECT/scripts/git-ssh-paramiko.py" \
    git push "git@github.com:shadow7019/OTAMA.git" "main:refs/heads/${REMOTE_BRANCH}"
fi
