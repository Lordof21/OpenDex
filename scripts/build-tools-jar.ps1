# Builds backend/vendor/opendex-tools.jar — the single on-device Java artifact
# (OpenDexDaemon, MediaBridge, NotificationInvoker, IconExtractor).
#
# Thin wrapper: backend/java/build.py is the ONE build definition (tool discovery,
# -source/-target 1.8, d8 --min-api 29, packaging). Keep build logic there, not here.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$buildScript = Join-Path $root "backend\java\build.py"

$python = (Get-Command py -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python not found (py / python)" }

& $python $buildScript
if ($LASTEXITCODE -ne 0) { throw "build.py failed (exit $LASTEXITCODE)" }
