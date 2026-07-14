#!/usr/bin/env bash
# Open Historia - content node one-click installer (Linux).
#   chmod +x install.sh && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

section() { echo ""; echo "==== $1 ===="; }
REGISTRY_DEFAULT="https://open-historia-registry.nichojkrol.workers.dev"

echo ""
echo "=============================================="
echo "  Open Historia - content node setup"
echo "  Help players load the game faster."
echo "=============================================="

# ---- 1. Node.js ----
section "1/5  Checking prerequisites (Node.js, git)"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local m; m=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$m" -ge 18 ] 2>/dev/null
}
if ! node_ok; then
  echo "Node.js 18+ not found - installing it via nvm (no admin needed)..."
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts || true
fi
if ! node_ok; then
  echo "Couldn't set up Node.js automatically. Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi
echo "Node.js $(node --version) ready."
command -v git >/dev/null 2>&1 || echo "Note: git isn't installed - the node runs, but automatic updates need it (install it via your package manager)."

# ---- 2. Dependencies ----
section "2/5  Installing dependencies"
( cd app && npm install --omit=dev )

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

# ---- 4. Cloudflare Tunnel ----
section "4/5  Cloudflare Tunnel"
echo "A Cloudflare Tunnel gives your node a public HTTPS address with no router"
echo "setup and without exposing your IP. It's free."
read -r -p "Set up a Cloudflare Tunnel now? [Y/n] " USE_TUNNEL
PUBLIC_URL=""; TUNNEL_MODE="none"; TUNNEL_NAME=""
if [[ ! "$USE_TUNNEL" =~ ^[Nn] ]]; then
  if [ ! -x app/cloudflared ]; then
    echo "Downloading cloudflared..."
    ARCH=$(uname -m); case "$ARCH" in x86_64) CF=amd64;; aarch64|arm64) CF=arm64;; armv7l) CF=arm;; *) CF=amd64;; esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF" -o app/cloudflared
    chmod +x app/cloudflared
  fi
  echo "cloudflared ready."
  echo ""
  echo "  1) Quick - instant, free, no account. URL changes if you restart it."
  echo "  2) Named - permanent URL, needs a domain on your Cloudflare account."
  read -r -p "Choose 1 (quick) or 2 (named) [1]: " KIND
  if [ "$KIND" = "2" ]; then
    echo "A browser will open to log in to Cloudflare..."
    app/cloudflared tunnel login
    read -r -p "Name for this tunnel [oh-node]: " TUNNEL_NAME; TUNNEL_NAME=${TUNNEL_NAME:-oh-node}
    app/cloudflared tunnel create "$TUNNEL_NAME"
    read -r -p "Hostname (a subdomain of your Cloudflare domain, e.g. node.example.com): " HOST1
    app/cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST1"
    PUBLIC_URL="https://$HOST1"; TUNNEL_MODE="named"
    echo "Named tunnel ready at $PUBLIC_URL"
  else
    TUNNEL_MODE="quick"; echo "Quick tunnel selected."
  fi
fi

# ---- 5. Map content ----
section "5/5  Downloading map content (~160 MB, one time)"
node app/scripts/populate.mjs || echo "Some content failed; re-run 'node app/scripts/populate.mjs' later."

# ---- Write config + start.sh (run.mjs starts the tunnel + node) ----
cat > node.config.json <<EOF
{
  "port": $PORT,
  "operator": "$OPERATOR",
  "region": "$REGION",
  "registry": "$REGISTRY",
  "directory": "$DIRECTORY",
  "tunnel": "$TUNNEL_MODE",
  "tunnelName": "$TUNNEL_NAME",
  "publicUrl": "$PUBLIC_URL"
}
EOF
cat > start.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node app/run.mjs
EOF
chmod +x start.sh

echo ""
echo "================= Setup complete! ================="
echo "  1. Start your node any time: ./start.sh"
echo "  2. It registers with the project as 'pending'."
echo "  3. Ask an admin to accept it - then players use it automatically."
echo "==================================================="
read -r -p "Start the node now? (y/N) " START_NOW
if [[ "$START_NOW" =~ ^[Yy] ]]; then exec ./start.sh; fi
