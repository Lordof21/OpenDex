@echo off
rem OpenDeX tam derleme (tek tikla): Java daemon (R8) + frontend (Vite+obfuscator) + backend (Nuitka) + Tauri installer.
rem Sure: ~19 dk. Cikti ekrana (yuzdelik asamali ilerleme cubugu ile) ve build_logs\derle_<tarih>.log dosyasina yazilir.
rem Parametreler: --no-obfuscate (okunur Java/JS), --pyinstaller (hizli backend, dakikalar)  ornek: derle_tam.bat --pyinstaller
setlocal
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

rem Calisan backend/opendex.exe dosyalari kilitler ve telefonu tutar: once kapatilmali.
tasklist /FI "IMAGENAME eq opendex.exe" 2>nul | find /I "opendex.exe" >nul
if not errorlevel 1 (
  echo [!] opendex.exe calisiyor. Derlemeden once kapat, sonra tekrar calistir.
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\anaconda3\Scripts\activate.bat" (
  echo [!] Anaconda bulunamadi: %USERPROFILE%\anaconda3
  pause
  exit /b 1
)
call "%USERPROFILE%\anaconda3\Scripts\activate.bat" fastapienv
if errorlevel 1 (
  echo [!] fastapienv ortami etkinlestirilemedi.
  pause
  exit /b 1
)

if not exist build_logs mkdir build_logs
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%t
set LOG=build_logs\derle_%STAMP%.log

echo Derleme basliyor: %DATE% %TIME%
echo Log: %LOG%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\derle_ilerleme.ps1" -LogFile "%LOG%" -BuildArgsText "%*"
set RC=%ERRORLEVEL%

echo.
if %RC%==0 (
  echo ===== DERLEME BASARILI  %DATE% %TIME% =====
  echo Installer: frontend\src-tauri\target\release\bundle
) else (
  echo ===== DERLEME BASARISIZ ^(kod %RC%^)  -  log: %LOG% =====
)
pause
exit /b %RC%
