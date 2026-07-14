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

The installer does **everything** — dependencies, map content, a **Cloudflare Tunnel**
so players can reach you, and a `start` script — and walks you through it.

1. **[Download this repository as a ZIP](https://github.com/Open-Historia/open-historia-node/archive/refs/heads/main.zip)** and unzip it (or `git clone`).
2. Run the installer:
   - **Windows:** double-click **`install.bat`**
   - **macOS:** double-click **`install.command`** (if macOS blocks it, right-click → **Open** the first time). No Homebrew required.
   - **Linux:** `chmod +x install.sh && ./install.sh`
3. Answer the few prompts. When it offers the **Cloudflare Tunnel**, pick:
   - **Quick** — instant, free, no account; a temporary `…trycloudflare.com` URL (fine to try it out; the URL changes if you restart).
   - **Named** — a **permanent** URL; it logs you in and routes a subdomain of your own Cloudflare domain. Best for a long-running node.

The installer writes a **`start`** script (`start.bat` / `start.command` / `start.sh`)
that launches the tunnel **and** the node together. Your node then **registers with the
project as `pending`**.

> **No player traffic reaches your node until an admin accepts it.** The game only ever
> contacts nodes in the project's *signed* directory, so an unapproved (or banned) node
> simply receives nothing.

## What's in the folder

Everything you touch is at the **top level**: the installers
(`install.bat` / `install.command` / `install.sh`), the **`start`** script the
installer creates, and your **`node.config.json`** (your node's name, region, and
tunnel). All of the node's code and its downloaded map cache live in the
**`app/`** folder — you never need to open it.

```
open-historia-node/
├─ install.bat / install.command / install.sh   ← run one of these first
├─ start.bat / start.command / start.sh          ← created by the installer
├─ node.config.json                              ← your settings
└─ app/                                           ← the node software (leave it be)
```

## Getting online without the installer

If you'd rather wire it up yourself, expose `http://localhost:4400` over HTTPS with a
Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:4400`), a reverse proxy
(Caddy/nginx), or a port-forward, and pass that URL as `OH_NODE_PUBLIC_URL`.

## Getting accepted

After your node is running and publicly reachable:

1. It appears to the project admins as a **pending** node.
2. An admin reviews it and **accepts** it into the signed node directory.
3. Players automatically start using it — no action needed on your side.

You can check your node's status any time at `http://localhost:4400/oh/v1/health`.

## Keeping it running

- **On boot / as a service:** wrap the `start` script (or `node app/run.mjs`) in a
  Windows service (e.g. [WinSW](https://github.com/winsw/winsw)) or a systemd unit so
  it restarts automatically. `run.mjs` supervises the node and applies signed updates.
- **Auto-update:** the node updates itself when an admin publishes a new signed version
  (it `git pull`s and restarts, keeping your tunnel up). No action needed. A standalone
  signed-feed updater is also available: `node app/scripts/updater.mjs`.
- **Refresh content** after a map update: `node app/scripts/populate.mjs`.

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
| `OH_NODE_CONTENT_DIR` | `./app/content` | Where verified map objects are stored |

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
