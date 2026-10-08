#!/usr/bin/env bash
# Regenerates docs/images/*.webp: starts the frontend dev server, takes the screenshots, stops the server.
#
#   tools/screenshots/run.sh               every screenshot
#   tools/screenshots/run.sh hero files    only these
#
# Needs: Node 18+, `npm ci` in frontend/, Playwright with a Chromium (PLAYWRIGHT_PATH points at its node module when it is not
# resolvable as `playwright`), Python 3 with Pillow (WebP conversion). No phone, no backend, no network.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-5173}"

python3 "$HERE/gen_fixtures.py"                       # the backend-derived part of the sample data, from the current code

cd "$ROOT/frontend"
npx vite --port "$PORT" --strictPort > "${TMPDIR:-/tmp}/opendex-screenshots-vite.log" 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/" > /dev/null 2>&1 && break
  sleep 0.5
done

APP_URL="http://127.0.0.1:$PORT" node "$HERE/shoot.cjs" "$@"
