#!/usr/bin/env bash
# Push the full Popcorn Time repo (local branch `main`, complete history) to
# git@github.com:shadow7019/popcorn-2.0.git  — the repo the user created for
# this project ("push everything here").
#
# Transport: no ssh binary exists in the sandbox, so git uses the paramiko
# wrapper (scripts/git-ssh-paramiko.py) with the deploy key in .ssh-deploy/.
# That key's PUBLIC half must be registered on the popcorn-2.0 repo as a
# Deploy key with WRITE access (Settings → Deploy keys) before this works:
#   cat .ssh-deploy/id_ed25519.pub
#
# Alternative auth (no deploy key needed): pass a GitHub PAT that has write
# access to shadow7019/popcorn-2.0:
#   bash scripts/push-popcorn2.sh --token <PAT>
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"
REMOTE="git@github.com:shadow7019/popcorn-2.0.git"

if [ "${1:-}" = "--token" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --token <PAT>" >&2; exit 1; }
  git push "https://x-access-token:${2}@github.com/shadow7019/popcorn-2.0.git" \
    main main:refs/heads/popcorn-time --tags
else
  GIT_SSH_COMMAND="python3 $PROJECT/scripts/git-ssh-paramiko.py" \
    git push "$REMOTE" main main:refs/heads/popcorn-time --tags
fi
echo "pushed: main (full history) + popcorn-time + tags -> shadow7019/popcorn-2.0"
