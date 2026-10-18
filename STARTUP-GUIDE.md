# God's Eye View (Meteor Intelligence) — Startup & Operations Guide

## 1. Quick Start (Self-Healing Local + Public Tunnel)

Double-click **`start-gev-meteor.cmd`** in `C:\Users\Don\Documents\GodsEyeView-Meteor` (or run from any terminal):

```bash
node scripts/start-meteor-dev.mjs
```

### What the Supervisor Does Automatically:
1. **Strict Port `:4173`:** Checks `http://127.0.0.1:4173/` every 5 seconds. If Vite is not running (or ever crashes/exits after a config reload), it automatically spawns `vite --port 4173 --strictPort`.
2. **Cloudflare Public Quick-Tunnel:** Ensures `cloudflared.exe` is running against `http://localhost:4173` with `--http-host-header localhost:4173` (so Vite's `build/allowedHosts.js` security check passes without modification).
3. **Live URL Tracking:** Writes the active `https://*.trycloudflare.com` URL to **`LIVE-TUNNEL-URL.txt`** in the repository root and logs activity to `dev-supervisor.log`.

---

## 2. Checking the Current Public URL

Read `LIVE-TUNNEL-URL.txt` in the project root:
```bash
cat LIVE-TUNNEL-URL.txt
```

> **Note on UniFi Local DNS:** Local router DNS (`192.168.1.1`) sometimes caches NXDOMAIN for freshly minted `*.trycloudflare.com` subdomains for a few minutes while phones/external networks resolve them immediately via Cloudflare DNS (`1.1.1.1`). Locally, you can always use **`http://localhost:4173`**.

---

## 3. Should We Port This to Docker? (Trade-Off Analysis)

| Approach | Pros | Cons on Windows 11 | Recommendation |
|---|---|---|---|
| **Native Node Supervisor (`scripts/start-meteor-dev.mjs`)** | Instant Vite HMR (<50 ms), direct file editing from IDE/Antigravity/Hermes, zero WSL2 filesystem overhead, auto-restarts on crash. | Uses host Node.js installation. | **Best for active daily development.** |
| **Docker Compose (Bind-Mounted Dev)** | Pinned Node runtime + bundled `cloudflared` sidecar container (`docker compose up -d`). | Windows $\rightarrow$ Linux bind mounts (`C:\Users\...`) require `CHOKIDAR_USEPOLLING=true` for Vite HMR, which adds higher CPU usage and ~500 ms reload latency. | **Great for hands-off hosting / staging.** |

If you want a `docker-compose.yml` alongside the native supervisor (so you can run `docker compose up -d` when hosting hands-off, and `node scripts/start-meteor-dev.mjs` when actively coding), we can add a non-intrusive `docker-compose.dev.yml` at any time.
