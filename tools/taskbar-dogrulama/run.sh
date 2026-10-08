#!/usr/bin/env bash
# Görev çubuğu görsel harness'ını başlatır (gerçek Taskbar + WindowPreview, sahte backend ve sahte canlı video tuvalleri). Dosyalar çıkışta silinir.
#   ./run.sh  → http://localhost:5200/harness.html?w=1280&h=420&theme=light|dark&wins=3
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$HERE/../../frontend"
cp "$HERE/harness.html" "$FE/harness.html"; cp "$HERE/harness.jsx" "$FE/harness.jsx"; cp "$HERE/vite.harness.config.mjs" "$FE/vite.harness.config.mjs"
trap 'rm -f "$FE/harness.html" "$FE/harness.jsx" "$FE/vite.harness.config.mjs"' EXIT
cd "$FE"
npx vite --config ./vite.harness.config.mjs --port "${PORT:-5200}" --strictPort
