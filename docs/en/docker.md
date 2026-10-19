# 🐳 Docker Deployment

## 🚀 Quick Start

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env    # Edit .env, API_KEY and OPENCODE_SERVER_PASSWORD are required
docker compose up -d

# Verify
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## ⚙️ Configuration

Common `.env` items (full list in [Configuration](./configuration.md)):

```env
# Required
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# Security
OPENCODE_DISABLE_TOOLS=true

# Optional
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 📦 Volumes

| Volume | Container Path | Description |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode data directory |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode config directory |

Project source is copied into the image at `/home/node/project` at build time. The host directory is not mounted by default, so `node_modules` in the image is not overwritten.

## 🔨 Custom Build

```bash
# Build image
docker build -t my-opencode2api .

# Run a single container
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode2api
```

## ☁️ Railway

Ready-to-use files: `railway.json` at the repo root (Dockerfile builder,
`/health` probe) and [`deploy/railway/`](../../deploy/railway/README.md)
(variable template + step-by-step for the proxy and relay services).

The published image runs unchanged as a Railway service.

1. **New Project → Deploy from Docker Image** →
   `ghcr.io/tiarabasori/opencode2api:latest`, or your own fork's image
   (`ghcr.io/<owner>/opencode2api:latest`) once its publish workflow has run.
2. **Variables**:
   - `API_KEY=...` and `OPENCODE_SERVER_PASSWORD=...` (the URL is public)
   - `OPENCODE_DISABLE_TOOLS=true`
   - optional: `OPENCODE_WEB_PANEL_ENABLED=true`, `OPENCODE_METRICS_ENABLED=true`
   - optional pool: `OPENCODE_PROXY_POOL='[{"name":"direct","type":"direct"},{"name":"relay","type":"relay","url":"https://relay-xxxx.up.railway.app"}]'`
   - do **not** set `OPENCODE_PROXY_PORT`: Railway injects `PORT` and the proxy
     listens on it (`OPENCODE_PROXY_PORT` would win and break routing).
3. **Settings → Networking → Generate Domain**, target port = the injected `PORT`.
4. Optional **volume** at `/home/node/.local/share/opencode` to keep OpenCode
   auth and session storage across deploys.
5. Health check path: `/health`.

Building your own image from a fork: enable GitHub Actions for the fork, merge
your branch into `main`, and the workflow publishes
`ghcr.io/<owner>/opencode2api:latest`. Make the package public (Package settings
→ Change visibility) or give Railway registry credentials before pulling.

**Relay on Railway**: deploy `relay/railway` as a second service from the same
repo (root directory `relay/railway`, builder Dockerfile) — see
[`relay/railway/README.md`](../../relay/railway/README.md). Then add its URL as
a `relay` pool entry. A relay in the same project/region shares the proxy's
egress IPs, so it adds failover but not IP rotation.

**Memory**: one `opencode serve` backend needs roughly 0.7–1 GB; a pool with N
entries runs N backends inside the same container.

## 📊 Log Management

```bash
# View logs
docker compose logs -f
```

Log rotation in Compose is recommended:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## ✅ Health Check

Compose has a built-in health check:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:10000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## ❓ FAQ

- **Container fails to start**: check logs with `docker compose logs`, confirm ports are free.
- **Mount permission issues**: check PUID/PGID (default 1000:1000).
