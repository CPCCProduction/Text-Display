#!/usr/bin/env bash
# Updates the running app to the latest commit on the tracked branch.
#
#   ssh <user>@<server> '~/text-display/deploy.sh'
#
# Pulls, rebuilds, restarts, and then checks the app actually answers with the
# commit it was told to deploy - a deploy that does not verify itself is just
# a hope.
set -euo pipefail

cd "$(dirname "$0")"

BRANCH="${BRANCH:-main}"
PORT="${PORT:-4321}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Fetching $BRANCH"
git fetch --prune origin "$BRANCH"

BEFORE="$(git rev-parse --short HEAD)"
git checkout -q "$BRANCH"
git reset --hard -q "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already at $AFTER - rebuilding anyway so a changed Dockerfile is picked up."
else
  echo "$BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
fi

# Stamped into the image so the running app can report what it is.
export GIT_COMMIT="$AFTER"
export GIT_BRANCH="$BRANCH"
export GIT_COMMITTED_AT="$(git log -1 --format=%cI)"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

say "Building"
docker compose build

say "Restarting"
docker compose up -d

say "Waiting for it to come back"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

LIVE="$(curl -fsS "http://127.0.0.1:${PORT}/api/state" 2>/dev/null \
  | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true)"

say "Result"
if [ -z "$LIVE" ]; then
  echo "The app did not answer on port ${PORT}. Recent logs:"
  docker compose logs --tail 30
  exit 1
fi

echo "  deployed commit : $AFTER"
echo "  reported by app : $LIVE"
if [ "$LIVE" = "$AFTER" ]; then
  echo "  OK - the running app is the commit that was just deployed."
else
  echo "  MISMATCH - the app is reporting a different commit. Something did not rebuild."
  exit 1
fi

docker image prune -f >/dev/null 2>&1 || true
