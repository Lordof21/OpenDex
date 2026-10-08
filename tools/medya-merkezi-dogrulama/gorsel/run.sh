#!/usr/bin/env bash
# Medya merkezini + görev çubuğu kartını sahte bir backend (fetch taklidi) ile tarayıcıda açan görsel doğrulama harness'ı.
# harness dosyalarını GEÇİCİ olarak frontend/ altına kopyalar, çıkışta siler (.gitignore'da da kayıtlıdır).
#   ./run.sh            → http://localhost:5199/harness.html?w=1280&h=720&theme=light|dark&scene=<sahne>
#   sahneler: playing paused pending noart multi live empty disconnected long
#   PORT=5200 ./run.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$HERE/../../../frontend"
cp "$HERE/harness.html" "$FE/harness.html"
cp "$HERE/harness.jsx" "$FE/harness.jsx"
cp "$HERE/vite.harness.config.mjs" "$FE/vite.harness.config.mjs"
trap 'rm -f "$FE/harness.html" "$FE/harness.jsx" "$FE/vite.harness.config.mjs"' EXIT
cd "$FE"
npx vite --config ./vite.harness.config.mjs --port "${PORT:-5199}" --strictPort
