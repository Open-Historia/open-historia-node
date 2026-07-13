<h1 align="center">Open Historia — Content Node</h1>

<p align="center">
  Run a node on your own device to help the <a href="https://github.com/Open-Historia/open-historia">Open Historia</a>
  network load faster for players — safely.
</p>

---

## What is this?

Open Historia is a browser game. The heavy part is the ~160 MB of **map data** every
player downloads. A **content node** is a small server you run that caches that map
data and serves it to nearby players, so the game starts faster and the load is
spread across the community instead of one central server.

**A node is deliberately harmless.** It only ever serves **read-only map files,
addressed and verified by SHA-256**. It does **not**:

- ❌ see or store anyone's **games** or accounts,
- ❌ ever touch anyone's **AI API keys** (those go straight from the player's browser to their AI provider),
- ❌ serve any **code** the player's browser runs (the game is always loaded from the official site).

Every byte your node sends is re-hashed by the player's browser against a
project-**signed** manifest before it's trusted. So even a hacked node can't feed
players bad data — the worst it can do is get ignored.

## Requirements

- **[Node.js 18+](https://nodejs.org/)** (LTS is fine).
- A way to make your machine reachable from the internet over **HTTPS** — a
  **[Cloudflare Tunnel](#exposing-your-node)** is the easiest and needs no open ports.
- ~200 MB of free disk for the map cache.

## One-click install

1. **[Download this repository as a ZIP](https://github.com/Open-Historia/open-historia-node/archive/refs/heads/main.zip)** and unzip it (or `git clone`).
2. Run the installer:
   - **Windows:** double-click **`install.bat`**
   - **macOS / Linux:** `chmod +x install.sh && ./install.sh`
3. Answer the few prompts (your public URL, name, region). The installer downloads
   and verifies the map content and writes a **`start.bat`** / **`start.sh`** you can
   run any time.

That's it. Your node starts and **registers itself with the project as `pending`**.

> **No player traffic reaches your node until an admin accepts it.** This is by
> design: the game only ever contacts nodes in the project's *signed* directory, so
> an unapproved (or banned) node simply receives nothing.

## Exposing your node

Your node listens locally (default port **4400**). To let players reach it you need a
public HTTPS URL. The easiest, safest option is a **Cloudflare Tunnel** (free, no
router ports, hides your home IP):

```bash
# one-time: install cloudflared, then
cloudflared tunnel --url http://localhost:4400
```

Cloudflare prints a public `https://…trycloudflare.com` URL — use that as your node's
**Public URL** during setup (for a permanent URL, create a named tunnel + your own
domain). Any HTTPS reverse proxy (Caddy, nginx) or port-forward works too.

## Getting accepted

After your node is running and publicly reachable:

1. It appears to the project admins as a **pending** node.
2. An admin reviews it and **accepts** it into the signed node directory.
3. Players automatically start using it — no action needed on your side.

You can check your node's status any time at `http://localhost:4400/oh/v1/health`.

## Keeping it running

- **On boot / as a service:** wrap `node node.js` (with the env from `start.bat`/
  `start.sh`) in a Windows service (e.g. [WinSW](https://github.com/winsw/winsw)) or a
  systemd unit so it restarts automatically.
- **Auto-update:** run the updater alongside the node to stay current and tamper-proof:
  ```bash
  OH_UPDATE_BASE_URL=<signed update feed> node scripts/updater.mjs
  ```
  It only ever applies updates that are validly **signed** by the project, strictly
  newer than what you run (no rollback), and unexpired.
- **Refresh content** after a map update: `npm run populate`.

## Configuration

The node reads these environment variables (the installer bakes your answers into
`start.bat` / `start.sh`):

| Variable | Default | Meaning |
|---|---|---|
| `OH_NODE_PORT` | `4400` | Local port to listen on |
| `OH_NODE_PUBLIC_URL` | — | The public HTTPS URL players reach you at |
| `OH_NODE_REGISTRY_URL` | — | Where the node registers itself |
| `OH_NODE_DIRECTORY_URL` | — | The signed node directory it obeys (accept/pause/ban/rate-limit) |
| `OH_NODE_OPERATOR` | — | Your name/handle (shown to admins) |
| `OH_NODE_REGION` | — | Region hint, e.g. `eu-west` |
| `OH_NODE_RATE_LIMIT` | `600` | Requests/minute/IP (admins can tighten this) |
| `OH_NODE_CONTENT_DIR` | `./content` | Where verified map objects are stored |

## Endpoints

- `GET /oh/v1/health` — liveness + status
- `GET /oh/v1/manifest` — node id, version, and the content hashes it holds
- `GET /oh/v1/content/:sha256` — a map object by hash (HTTP Range supported)

## Security model, in one line

**Trust is in the hash and the signature, never in the node.** Players verify every
byte against the project-signed manifest, only ever contact nodes in the signed
directory, and never hand a node their keys, games, or code. Run one with confidence —
and know it can't be turned against anyone.

## License

MIT © Nicholas Krol. See [LICENSE](LICENSE).
