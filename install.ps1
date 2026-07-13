# Open Historia — content node one-click installer (Windows).
# Double-click install.bat (which runs this). Sets up dependencies, downloads the
# map content, writes your config, and creates start.bat to run the node.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Open Historia - content node setup" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js check
try {
  $nodeVersion = (node --version)
  $major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
  if ($major -lt 18) { throw "too old" }
  Write-Host "Node.js $nodeVersion found." -ForegroundColor Green
} catch {
  Write-Host "Node.js 18+ is required and was not found." -ForegroundColor Red
  Write-Host "Install it from https://nodejs.org/ (LTS), then run this installer again."
  Start-Process "https://nodejs.org/en/download"
  Read-Host "Press Enter to exit"
  exit 1
}

# 2. Dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { Read-Host "npm install failed. Press Enter to exit"; exit 1 }

# 3. Config
Write-Host ""
Write-Host "A few questions (press Enter to accept the default in [brackets]):" -ForegroundColor Cyan
$publicUrl = Read-Host "Public HTTPS URL players will reach this node at (e.g. https://mynode.example). Leave blank to set up later"
$operator  = Read-Host "Your name or handle (shown to the admin, optional)"
$region    = Read-Host "Region, e.g. us-east / eu-west (optional)"
$registry  = Read-Host "Registry URL [https://registry.open-historia.example]"
if ([string]::IsNullOrWhiteSpace($registry)) { $registry = "https://registry.open-historia.example" }
$directory = Read-Host "Signed node-directory URL [https://open-historia.github.io/open-historia/node-directory.json]"
if ([string]::IsNullOrWhiteSpace($directory)) { $directory = "https://open-historia.github.io/open-historia/node-directory.json" }
$port = Read-Host "Local port [4400]"
if ([string]::IsNullOrWhiteSpace($port)) { $port = "4400" }

# 4. Write start.bat with the config baked in
$startBat = @"
@echo off
cd /d "%~dp0"
set OH_NODE_PORT=$port
set OH_NODE_PUBLIC_URL=$publicUrl
set OH_NODE_OPERATOR=$operator
set OH_NODE_REGION=$region
set OH_NODE_REGISTRY_URL=$registry
set OH_NODE_DIRECTORY_URL=$directory
node node.js
pause
"@
Set-Content -Path (Join-Path $PSScriptRoot "start.bat") -Value $startBat -Encoding ASCII
Write-Host "Wrote start.bat" -ForegroundColor Green

# 5. Download the map content (~160 MB, verified by SHA-256)
Write-Host ""
Write-Host "Downloading + verifying map content (~160 MB, one time)..." -ForegroundColor Cyan
npm run populate
if ($LASTEXITCODE -ne 0) { Write-Host "Some content failed to download; you can re-run 'npm run populate' later." -ForegroundColor Yellow }

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host "  - Start your node any time by double-clicking start.bat"
Write-Host "  - Expose it publicly (Cloudflare Tunnel is easiest - see README.md)"
Write-Host "  - It registers as 'pending'; an admin must accept it before players use it."
Write-Host ""
$startNow = Read-Host "Start the node now? (y/N)"
if ($startNow -match "^[Yy]") { & (Join-Path $PSScriptRoot "start.bat") }
