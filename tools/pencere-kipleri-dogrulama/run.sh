#!/usr/bin/env bash
# Pencere kipleri harness'ını başlatır (gerçek WindowFrame + Taskbar, sahte backend ve sahte video tuvali). Dosyalar çıkışta silinir.
#   ./run.sh  → http://localhost:5201/harness.html?w=1280&h=720&latency=300
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$HERE/../../frontend"
FILES=(harness.html harness.jsx harness-video-canvas.jsx vite.harness.config.mjs)
for f in "${FILES[@]}"; do cp "$HERE/$f" "$FE/$f"; done
trap 'for f in "${FILES[@]}"; do rm -f "$FE/$f"; done' EXIT
cd "$FE"
npx vite --config ./vite.harness.config.mjs --port "${PORT:-5201}" --strictPort
