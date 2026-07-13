@echo off
REM Open Historia content node - one-click installer (Windows).
REM Double-click this file. It runs the PowerShell setup which installs
REM dependencies, downloads the map content, and creates start.bat.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Setup did not complete. See the messages above.
  pause
)
