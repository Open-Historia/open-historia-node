# Open Historia - content node one-click installer (Windows).
# Double-click install.bat (which runs this). It installs dependencies, downloads
# the map content, downloads cloudflared, sets up a Cloudflare Tunnel so players
# can reach your node, and writes start.bat to run everything.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Section($t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Cyan }

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Open Historia - content node setup" -ForegroundColor Cyan
Write-Host "  Help players load the game faster." -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# ---- 1. Node.js ----
Section "1/5  Checking Node.js"
try {
  $nodeVersion = (node --version)
  if ([int]($nodeVersion.TrimStart("v").Split(".")[0]) -lt 18) { throw "too old" }
  Write-Host "Node.js $nodeVersion found." -ForegroundColor Green
} catch {
  Write-Host "Node.js 18+ is required and was not found." -ForegroundColor Red
  Write-Host "Opening the download page - install the LTS, then run this installer again."
  Start-Process "https://nodejs.org/en/download"
  Read-Host "Press Enter to exit"; exit 1
}

# ---- 2. Dependencies ----
Section "2/5  Installing dependencies"
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { Read-Host "npm install failed. Press Enter to exit"; exit 1 }

# ---- 3. Your details ----
Section "3/5  A few questions"
Write-Host "(press Enter to accept the default in [brackets])"
$operator  = Read-Host "Your name or handle (shown to the admin, optional)"
$region    = Read-Host "Region, e.g. us-east / eu-west (optional)"
$port      = Read-Host "Local port [4400]"; if ([string]::IsNullOrWhiteSpace($port)) { $port = "4400" }
$registry  = Read-Host "Registry URL [https://open-historia-registry.nichojkrol.workers.dev]"
if ([string]::IsNullOrWhiteSpace($registry)) { $registry = "https://open-historia-registry.nichojkrol.workers.dev" }
$directory = "$($registry.TrimEnd('/'))/node-directory.json"

# ---- 4. Cloudflare Tunnel (makes your node reachable, no open ports) ----
Section "4/5  Cloudflare Tunnel"
Write-Host "A Cloudflare Tunnel gives your node a public HTTPS address with no router"
Write-Host "setup and without exposing your home IP. It's free."
$useTunnel = Read-Host "Set up a Cloudflare Tunnel now? [Y/n]"
$publicUrl = ""
$tunnelCmd = ""
if ($useTunnel -notmatch "^[Nn]") {
  $cf = Join-Path $PSScriptRoot "cloudflared.exe"
  if (-not (Test-Path $cf)) {
    Write-Host "Downloading cloudflared..." -ForegroundColor Cyan
    $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile $cf
  }
  Write-Host "cloudflared ready." -ForegroundColor Green
  Write-Host ""
  Write-Host "Two kinds of tunnel:" -ForegroundColor Cyan
  Write-Host "  1) Quick    - instant, free, no account. URL changes if you restart it."
  Write-Host "  2) Named    - permanent URL, needs a domain on your Cloudflare account."
  $kind = Read-Host "Choose 1 (quick) or 2 (named) [1]"
  if ($kind -eq "2") {
    Write-Host "A browser will open to log in to Cloudflare..." -ForegroundColor Cyan
    & $cf tunnel login
    $tname = Read-Host "Name for this tunnel [oh-node]"; if ([string]::IsNullOrWhiteSpace($tname)) { $tname = "oh-node" }
    & $cf tunnel create $tname
    $host1 = Read-Host "Hostname to use (a subdomain of your Cloudflare domain, e.g. node.example.com)"
    & $cf tunnel route dns $tname $host1
    $publicUrl = "https://$host1"
    $tunnelCmd = "`"%~dp0cloudflared.exe`" tunnel run --url http://localhost:$port $tname"
    Write-Host "Named tunnel ready at $publicUrl" -ForegroundColor Green
  } else {
    # Quick tunnel: start.bat launches cloudflared, reads the printed URL, then starts the node.
    $tunnelCmd = "QUICK"
    Write-Host "Quick tunnel selected - your public URL is created each time you start." -ForegroundColor Green
  }
}

# ---- 5. Map content ----
Section "5/5  Downloading map content (~160 MB, one time)"
npm run populate
if ($LASTEXITCODE -ne 0) { Write-Host "Some content failed; re-run 'npm run populate' later." -ForegroundColor Yellow }

# ---- Write start.bat ----
if ($tunnelCmd -eq "QUICK") {
  $startBat = @"
@echo off
cd /d "%~dp0"
set OH_NODE_PORT=$port
set OH_NODE_OPERATOR=$operator
set OH_NODE_REGION=$region
set OH_NODE_REGISTRY_URL=$registry
set OH_NODE_DIRECTORY_URL=$directory
echo Starting Cloudflare Tunnel...
start "" /b cloudflared.exe tunnel --url http://localhost:$port > cloudflared.log 2>&1
echo Waiting for the tunnel URL...
set OH_NODE_PUBLIC_URL=
for /l %%i in (1,1,30) do (
  for /f "tokens=*" %%u in ('findstr /r /c:"https://[a-z0-9-]*\.trycloudflare\.com" cloudflared.log 2^>nul') do (
    for /f "tokens=2 delims= " %%p in ("%%u") do if not defined OH_NODE_PUBLIC_URL set OH_NODE_PUBLIC_URL=%%p
  )
  if defined OH_NODE_PUBLIC_URL goto :ready
  timeout /t 1 >nul
)
:ready
echo Your node is reachable at %OH_NODE_PUBLIC_URL%
node node.js
pause
"@
} else {
  $tunnelLine = if ($tunnelCmd) { "start `"`" /b $tunnelCmd" } else { "" }
  $startBat = @"
@echo off
cd /d "%~dp0"
set OH_NODE_PORT=$port
set OH_NODE_OPERATOR=$operator
set OH_NODE_REGION=$region
set OH_NODE_REGISTRY_URL=$registry
set OH_NODE_DIRECTORY_URL=$directory
set OH_NODE_PUBLIC_URL=$publicUrl
$tunnelLine
node node.js
pause
"@
}
Set-Content -Path (Join-Path $PSScriptRoot "start.bat") -Value $startBat -Encoding ASCII

Write-Host ""
Write-Host "================= Setup complete! =================" -ForegroundColor Green
Write-Host "  1. Start your node any time: double-click start.bat"
Write-Host "  2. It registers with the project as 'pending'."
Write-Host "  3. Ask an admin to accept it - then players start using it automatically."
Write-Host "     (No player traffic reaches an unapproved node.)"
Write-Host "==================================================="
$startNow = Read-Host "Start the node now? (y/N)"
if ($startNow -match "^[Yy]") { & (Join-Path $PSScriptRoot "start.bat") }
