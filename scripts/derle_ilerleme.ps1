# derle_tam.bat'ın ilerleme sarmalayıcısı: build_release.py'yi çalıştırır, çıktısını (log dosyasına da) aktarır ve
# aşamalara göre yüzdelik ilerleme çubuğu gösterir.
#
# Aşama sınırları build_release.py'nin "[n/4]" başlıklarından okunur (kesin). Aşama İÇİ yüzde tahmindir: geçen süre / beklenen süre
# (en çok %97'ye kadar; aşama gerçekten bitince bir sonrakine atlar). Beklenen süreler son BAŞARILI derlemeden öğrenilir
# (build_logs\asama_sureleri.json); ilk çalıştırmada varsayılanlar kullanılır.
param(
    [Parameter(Mandatory = $true)][string]$LogFile,
    [string]$BuildArgsText = '',   # derle_tam.bat'a verilen parametreler (boşlukla ayrık)
    [string]$Script = ''           # yalnız deneme için: build_release.py yerine başka betik
)

$ErrorActionPreference = 'Stop'
$BuildArgs = @($BuildArgsText -split '\s+' | Where-Object { $_ })
$root = Split-Path -Parent $PSScriptRoot
$timesFile = Join-Path $root 'build_logs\asama_sureleri.json'

# Aşama: ad, varsayılan süre (sn). Sıra = build_release.py sırası.
$stages = @(
    @{ Key = '1'; Name = 'Java daemon (R8)';              Expected = 40 },
    @{ Key = '2'; Name = 'Arayüz (Vite + obfuscator)';     Expected = 90 },
    @{ Key = '3'; Name = 'Backend (Nuitka / PyInstaller)'; Expected = 720 },
    @{ Key = '4'; Name = 'Kurulum paketi (Tauri)';         Expected = 300 }
)
if ($BuildArgs -contains '--pyinstaller') { $stages[2].Expected = 90 }
if (Test-Path $timesFile) {
    try {
        $saved = Get-Content $timesFile -Raw | ConvertFrom-Json
        foreach ($s in $stages) {
            $v = $saved.PSObject.Properties[$s.Key].Value
            if ($v -and $v -gt 3) { $s.Expected = [double]$v }
        }
    } catch { }
}
$total = 0.0
foreach ($s in $stages) { $total += $s.Expected }
$acc = 0.0
foreach ($s in $stages) {
    $s.From = 100.0 * $acc / $total
    $acc += $s.Expected
    $s.To = 100.0 * $acc / $total
}

function Format-Bar([double]$pct) {
    $w = 30
    $n = [int][math]::Floor($w * $pct / 100.0)
    return ('█' * $n) + ('░' * ($w - $n))
}

$skipBackend = $BuildArgs -contains '--skip-backend'
$skipInstaller = $BuildArgs -contains '--skip-installer'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'python'
$psi.Arguments = (@('-u', $(if ($Script) { $Script } else { Join-Path $PSScriptRoot 'build_release.py' })) + $BuildArgs) -join ' '
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
$psi.EnvironmentVariables['PYTHONUNBUFFERED'] = '1'

$queue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$handler = { if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) } }
$e1 = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $handler -MessageData $queue
$e2 = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $handler -MessageData $queue

$logWriter = New-Object System.IO.StreamWriter($LogFile, $false, (New-Object System.Text.UTF8Encoding($false)))
$logWriter.AutoFlush = $true

$t0 = Get-Date
$current = -1                  # stages dizisindeki indeks; -1 = henüz başlamadı
$stageStart = $t0
$durations = @{}               # tamamlanan aşamaların gerçek süreleri
$pct = 0.0
$status = 'Başlıyor'

function Show-Status {
    $elapsed = ((Get-Date) - $t0)
    $act = "OpenDeX tam derleme   %{0,5:N1}   geçen {1:mm\:ss}" -f $pct, $elapsed
    Write-Progress -Activity $act -Status $status -PercentComplete ([int][math]::Floor($pct))
}

function Enter-Stage([int]$idx) {
    if ($current -ge 0) {
        $durations[$stages[$current].Key] = ((Get-Date) - $stageStart).TotalSeconds
    }
    $script:current = $idx
    $script:stageStart = Get-Date
    $s = $stages[$idx]
    $script:pct = $s.From
    $script:status = "Aşama $($idx + 1)/4: $($s.Name)"
    $line = "`n[%{0,3:N0}] {1} Aşama {2}/4 — {3}`n" -f $s.From, (Format-Bar $s.From), ($idx + 1), $s.Name
    Write-Host $line -ForegroundColor Cyan
    $logWriter.WriteLine($line)
}

$null = $proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

while (-not $proc.HasExited -or -not $queue.IsEmpty) {
    $line = $null
    $drained = 0
    while ($queue.TryDequeue([ref]$line)) {
        $drained++
        $logWriter.WriteLine($line)
        Write-Host $line
        if ($line -match '^\s*\[(\d)/4\]') {
            $idx = [int]$Matches[1] - 1
            if ($idx -ge 0 -and $idx -lt 4 -and $idx -ne $current) { Enter-Stage $idx }
        } elseif ($line -match 'Release build finished') {
            $status = 'Tamamlanıyor'
        }
    }
    if ($current -ge 0) {
        $s = $stages[$current]
        $frac = [math]::Min(0.97, ((Get-Date) - $stageStart).TotalSeconds / $s.Expected)
        $pct = $s.From + ($s.To - $s.From) * $frac
    }
    Show-Status
    if ($drained -eq 0) { Start-Sleep -Milliseconds 400 }
}
$proc.WaitForExit()
$rc = $proc.ExitCode
Unregister-Event -SourceIdentifier $e1.Name -ErrorAction SilentlyContinue
Unregister-Event -SourceIdentifier $e2.Name -ErrorAction SilentlyContinue
Write-Progress -Activity 'OpenDeX tam derleme' -Completed

$elapsed = ((Get-Date) - $t0)
if ($rc -eq 0) {
    if ($current -ge 0) { $durations[$stages[$current].Key] = ((Get-Date) - $stageStart).TotalSeconds }
    # Atlanan aşamalar (--skip-*) süre yazmaz; yalnız ölçülenler güncellenir, diğerleri eski değerini korur.
    $keep = @{}
    foreach ($s in $stages) { $keep[$s.Key] = $s.Expected }
    foreach ($k in $durations.Keys) { if ($durations[$k] -gt 3) { $keep[$k] = [math]::Round($durations[$k], 1) } }
    New-Item -ItemType Directory -Force -Path (Split-Path $timesFile) | Out-Null
    ($keep | ConvertTo-Json) | Set-Content -Path $timesFile -Encoding UTF8
    $done = "`n[%100] {0} Tamamlandı — toplam {1:mm\:ss}`n" -f (Format-Bar 100), $elapsed
    Write-Host $done -ForegroundColor Green
    $logWriter.WriteLine($done)
} else {
    $fail = "`n[%{0,3:N0}] {1} BAŞARISIZ (kod {2}) — {3}`n" -f $pct, (Format-Bar $pct), $rc, $status
    Write-Host $fail -ForegroundColor Red
    $logWriter.WriteLine($fail)
}
$logWriter.Dispose()
exit $rc
