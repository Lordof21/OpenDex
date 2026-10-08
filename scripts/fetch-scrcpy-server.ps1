# Downloads the pinned scrcpy-server build into backend/vendor.
# Version is pinned in backend/app/config.py (SCRCPY_CLIENT_VERSION) — keep both in sync.

$ErrorActionPreference = "Stop"
$version = "4.1"
$dest = Join-Path $PSScriptRoot "..\backend\vendor\scrcpy-server-v$version"
$url = "https://github.com/Genymobile/scrcpy/releases/download/v$version/scrcpy-server-v$version"

Write-Host "Downloading scrcpy-server v$version ..."
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

$bytes = [System.IO.File]::ReadAllBytes($dest)[0..1]
if ([System.Text.Encoding]::ASCII.GetString($bytes) -ne "PK") {
    throw "Downloaded file is not a valid jar (missing PK signature)."
}
Write-Host "OK: $dest ($((Get-Item $dest).Length) bytes)"
