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
Push-Location (Join-Path $PSScriptRoot "app")
npm install --omit=dev
$installOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $installOk) { Read-Host "npm install failed. Press Enter to exit"; exit 1 }

# ---- 3. Your details ----
Section "3/5  A few questions"
Write-Host "(press Enter to accept the default in [brackets])"
$operator  = Read-Host "Your name or handle (shown to the admin, optional)"

# Region is required - it decides which players get routed to your node.
$regions = @(
  @{code="us-east";      label="North America - East"},
  @{code="us-central";   label="North America - Central"},
  @{code="us-west";      label="North America - West"},
  @{code="sa-east";      label="South America"},
  @{code="eu-west";      label="Europe - West"},
  @{code="eu-central";   label="Europe - Central"},
  @{code="eu-north";     label="Europe - North"},
  @{code="me";           label="Middle East"},
  @{code="af";           label="Africa"},
  @{code="ap-south";     label="Asia - South (India)"},
  @{code="ap-southeast"; label="Asia - Southeast"},
  @{code="ap-east";      label="Asia - East"},
  @{code="oceania";      label="Oceania (Australia / NZ)"}
)
Write-Host "Select the region your node serves:"
for ($i = 0; $i -lt $regions.Count; $i++) { Write-Host ("  {0,2}) {1}" -f ($i + 1), $regions[$i].label) }
do {
  $sel = Read-Host "Enter a number (1-$($regions.Count))"
  $n = 0
  $ok = [int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $regions.Count
  if (-not $ok) { Write-Host "Please enter a number between 1 and $($regions.Count)." -ForegroundColor Yellow }
} while (-not $ok)
$region = $regions[$n - 1].code
Write-Host ("Region: {0}" -f $region) -ForegroundColor Green

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
$tunnelMode = "none"
$tunnelName = ""
if ($useTunnel -notmatch "^[Nn]") {
  $cf = Join-Path $PSScriptRoot "app\cloudflared.exe"
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
    $tunnelMode = "named"; $tunnelName = $tname
    Write-Host "Named tunnel ready at $publicUrl" -ForegroundColor Green
  } else {
    $tunnelMode = "quick"
    Write-Host "Quick tunnel selected - your public URL is created each time you start." -ForegroundColor Green
  }
}

# ---- 5. Map content ----
Section "5/5  Downloading map content (~160 MB, one time)"
node app\scripts\populate.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "Some content failed; re-run 'node app\scripts\populate.mjs' later." -ForegroundColor Yellow }

# ---- Write config + start.bat (run.mjs starts the tunnel + node reliably) ----
$config = [ordered]@{
  port = [int]$port; operator = $operator; region = $region
  registry = $registry; directory = $directory
  tunnel = $tunnelMode; tunnelName = $tunnelName; publicUrl = $publicUrl
}
# Write UTF-8 WITHOUT a BOM — PowerShell 5.1's "-Encoding UTF8" adds a BOM that
# breaks JSON.parse in Node, so write the bytes ourselves.
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "node.config.json"), ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
$startBat = @"
@echo off
cd /d "%~dp0"
node app\run.mjs
pause
"@
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
