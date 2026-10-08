#!/usr/bin/env bash
# Dosya yöneticisini sahte bir backend (fetch taklidi) ile tarayıcıda açan görsel doğrulama harness'ını başlatır.
# harness dosyalarını GEÇİCİ olarak frontend/ altına kopyalar, çıkışta siler (.gitignore'da da kayıtlıdır).
#   ./run.sh            → http://localhost:5199/harness.html?w=1100&h=700&theme=light|dark&loc=phone|dcim|pc|big|docs&view=list|grid
#   PORT=5200 ./run.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$HERE/../../../frontend"
cp "$HERE/harness.html" "$FE/harness.html"
cp "$HERE/harness.jsx" "$FE/harness.jsx"
cp "$HERE/vite.harness.config.mjs" "$FE/vite.harness.config.mjs"
python3 "$HERE/belgeler/uret.py" "$FE/harness-fixtures" > /dev/null          # önizleme için gerçek PDF/DOCX/XLSX/PPTX
trap 'rm -rf "$FE/harness.html" "$FE/harness.jsx" "$FE/vite.harness.config.mjs" "$FE/harness-fixtures"' EXIT
cd "$FE"
npx vite --config ./vite.harness.config.mjs --port "${PORT:-5199}" --strictPort
