#!/usr/bin/env bash
# Open Historia - content node one-click installer (Linux / macOS).
#   chmod +x install.sh && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "=============================================="
echo "  Open Historia - content node setup"
echo "=============================================="
echo ""

# 1. Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node --version))." >&2
  exit 1
fi
echo "Node.js $(node --version) found."

# 2. Dependencies
echo "Installing dependencies..."
npm install --omit=dev

# 3. Config
echo ""
echo "A few questions (press Enter to accept the default in [brackets]):"
read -r -p "Public HTTPS URL players will reach this node at (blank = set up later): " PUBLIC_URL
read -r -p "Your name or handle (optional): " OPERATOR
read -r -p "Region, e.g. us-east / eu-west (optional): " REGION
read -r -p "Registry URL [https://registry.open-historia.example]: " REGISTRY
REGISTRY=${REGISTRY:-https://registry.open-historia.example}
read -r -p "Signed node-directory URL [https://open-historia.github.io/open-historia/node-directory.json]: " DIRECTORY
DIRECTORY=${DIRECTORY:-https://open-historia.github.io/open-historia/node-directory.json}
read -r -p "Local port [4400]: " PORT
PORT=${PORT:-4400}

# 4. Write start.sh with the config baked in
cat > start.sh <<EOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
export OH_NODE_PORT="$PORT"
export OH_NODE_PUBLIC_URL="$PUBLIC_URL"
export OH_NODE_OPERATOR="$OPERATOR"
export OH_NODE_REGION="$REGION"
export OH_NODE_REGISTRY_URL="$REGISTRY"
export OH_NODE_DIRECTORY_URL="$DIRECTORY"
exec node node.js
EOF
chmod +x start.sh
echo "Wrote start.sh"

# 5. Download map content
echo ""
echo "Downloading + verifying map content (~160 MB, one time)..."
npm run populate || echo "Some content failed; re-run 'npm run populate' later."

echo ""
echo "Setup complete!"
echo "  - Start your node any time with ./start.sh"
echo "  - Expose it publicly (Cloudflare Tunnel is easiest - see README.md)"
echo "  - It registers as 'pending'; an admin must accept it before players use it."
echo ""
read -r -p "Start the node now? (y/N) " START_NOW
if [[ "$START_NOW" =~ ^[Yy] ]]; then exec ./start.sh; fi
