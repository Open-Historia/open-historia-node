#!/usr/bin/env bash
# Open Historia - content node one-click installer (macOS).
# Double-click this file in Finder. If macOS blocks it, right-click -> Open the
# first time. No Homebrew required.
set -euo pipefail
cd "$(dirname "$0")"

section() { echo ""; echo "==== $1 ===="; }
REGISTRY_DEFAULT="https://open-historia-registry.nichojkrol.workers.dev"

echo ""
echo "=============================================="
echo "  Open Historia - content node setup (macOS)"
echo "  Help players load the game faster."
echo "=============================================="

# ---- 1. Node.js (no Homebrew - use the official .pkg) ----
section "1/5  Checking Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node.js 18+ is required and was not found."
  echo "Opening the official download page - install the macOS Installer (.pkg),"
  echo "then double-click this installer again. (No Homebrew needed.)"
  open "https://nodejs.org/en/download/" || true
  echo ""
  read -r -p "Press Enter to exit."
  exit 1
fi
echo "Node.js $(node --version) found."

# ---- 2. Dependencies ----
section "2/5  Installing dependencies"
npm install --omit=dev

# ---- 3. Your details ----
section "3/5  A few questions"
echo "(press Enter to accept the default in [brackets])"
read -r -p "Your name or handle (optional): " OPERATOR

# Region is required - it decides which players get routed to your node.
REGION_CODES=(us-east us-central us-west sa-east eu-west eu-central eu-north me af ap-south ap-southeast ap-east oceania)
REGION_LABELS=("North America - East" "North America - Central" "North America - West" "South America" "Europe - West" "Europe - Central" "Europe - North" "Middle East" "Africa" "Asia - South (India)" "Asia - Southeast" "Asia - East" "Oceania (Australia / NZ)")
echo "Select the region your node serves:"
for i in "${!REGION_LABELS[@]}"; do printf "  %2d) %s\n" "$((i+1))" "${REGION_LABELS[$i]}"; done
REGION=""
while [ -z "$REGION" ]; do
  read -r -p "Enter a number (1-${#REGION_CODES[@]}): " n
  if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#REGION_CODES[@]}" ]; then
    REGION="${REGION_CODES[$((n-1))]}"
  else
    echo "Please enter a number between 1 and ${#REGION_CODES[@]}."
  fi
done
echo "Region: $REGION"

read -r -p "Local port [4400]: " PORT; PORT=${PORT:-4400}
read -r -p "Registry URL [$REGISTRY_DEFAULT]: " REGISTRY; REGISTRY=${REGISTRY:-$REGISTRY_DEFAULT}
DIRECTORY="${REGISTRY%/}/node-directory.json"

# ---- 4. Cloudflare Tunnel (no Homebrew - download the darwin binary) ----
section "4/5  Cloudflare Tunnel"
echo "A Cloudflare Tunnel gives your node a public HTTPS address with no router"
echo "setup and without exposing your IP. It's free."
read -r -p "Set up a Cloudflare Tunnel now? [Y/n] " USE_TUNNEL
PUBLIC_URL=""; TUNNEL_MODE="none"; TUNNEL_NAME=""
if [[ ! "$USE_TUNNEL" =~ ^[Nn] ]]; then
  if [ ! -x ./cloudflared ]; then
    echo "Downloading cloudflared..."
    ARCH=$(uname -m); case "$ARCH" in arm64) CF=arm64;; *) CF=amd64;; esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CF.tgz" -o cloudflared.tgz
    tar xzf cloudflared.tgz
    chmod +x cloudflared
    rm -f cloudflared.tgz
  fi
  echo "cloudflared ready."
  echo ""
  echo "  1) Quick - instant, free, no account. URL changes if you restart it."
  echo "  2) Named - permanent URL, needs a domain on your Cloudflare account."
  read -r -p "Choose 1 (quick) or 2 (named) [1]: " KIND
  if [ "$KIND" = "2" ]; then
    echo "A browser will open to log in to Cloudflare..."
    ./cloudflared tunnel login
    read -r -p "Name for this tunnel [oh-node]: " TUNNEL_NAME; TUNNEL_NAME=${TUNNEL_NAME:-oh-node}
    ./cloudflared tunnel create "$TUNNEL_NAME"
    read -r -p "Hostname (a subdomain of your Cloudflare domain, e.g. node.example.com): " HOST1
    ./cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST1"
    PUBLIC_URL="https://$HOST1"; TUNNEL_MODE="named"
    echo "Named tunnel ready at $PUBLIC_URL"
  else
    TUNNEL_MODE="quick"; echo "Quick tunnel selected."
  fi
fi

# ---- 5. Map content ----
section "5/5  Downloading map content (~160 MB, one time)"
npm run populate || echo "Some content failed; re-run 'npm run populate' later."

# ---- Write start.command (double-clickable) ----
{
  echo '#!/usr/bin/env bash'
  echo 'cd "$(dirname "$0")"'
  echo "export OH_NODE_PORT=\"$PORT\""
  echo "export OH_NODE_OPERATOR=\"$OPERATOR\""
  echo "export OH_NODE_REGION=\"$REGION\""
  echo "export OH_NODE_REGISTRY_URL=\"$REGISTRY\""
  echo "export OH_NODE_DIRECTORY_URL=\"$DIRECTORY\""
  if [ "$TUNNEL_MODE" = "quick" ]; then
    echo 'echo "Starting Cloudflare Tunnel..."'
    echo "./cloudflared tunnel --url http://localhost:$PORT > cloudflared.log 2>&1 &"
    echo 'for i in $(seq 1 30); do URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" cloudflared.log | head -1); [ -n "$URL" ] && break; sleep 1; done'
    echo 'export OH_NODE_PUBLIC_URL="$URL"'
    echo 'echo "Your node is reachable at $OH_NODE_PUBLIC_URL"'
  elif [ "$TUNNEL_MODE" = "named" ]; then
    echo "export OH_NODE_PUBLIC_URL=\"$PUBLIC_URL\""
    echo "./cloudflared tunnel run --url http://localhost:$PORT \"$TUNNEL_NAME\" &"
  fi
  echo 'exec node node.js'
} > start.command
chmod +x start.command

echo ""
echo "================= Setup complete! ================="
echo "  1. Start your node any time: double-click start.command"
echo "  2. It registers with the project as 'pending'."
echo "  3. Ask an admin to accept it - then players use it automatically."
echo "==================================================="
read -r -p "Start the node now? (y/N) " START_NOW
if [[ "$START_NOW" =~ ^[Yy] ]]; then exec ./start.command; fi
