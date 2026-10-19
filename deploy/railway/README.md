# Railway deployment

Two services, both from this repository:

| Service | Root directory | What it is |
|---|---|---|
| `opencode2api` | `/` (repo root) | the proxy; runs `opencode serve` inside its own container |
| `relay` | `relay/railway` | optional egress relay (own service, own IP) |

`railway.json` in each root directory tells Railway to build the Dockerfile,
probe `/health`, and restart on failure.

## 1. Proxy service

**Option A — build from the repo (recommended for this fork):**

1. Railway → **New Project → Deploy from GitHub repo** → pick your fork.
2. Service **Settings → Source → Root Directory**: leave empty (repo root).
   Builder is detected as Dockerfile from `railway.json`.
3. **Variables**: copy [`variables.example`](./variables.example) into the
   Variables tab and replace the secrets.
4. **Settings → Networking → Generate Domain**. Target port: the injected
   `PORT` value (Railway shows it; the proxy listens on it).
5. Optional **Volume** → mount path `/home/node/.local/share/opencode` to keep
   OpenCode auth and sessions across deploys.

**Option B — use a prebuilt image:**

- This fork publishes `ghcr.io/<owner>/opencode2api:latest` from the
  `Publish Docker Image` workflow (push to `main`, or run it manually).
- Railway → **New Project → Deploy from Docker Image** → paste that reference.
- If the GHCR package is private, add registry credentials in Railway
  (Settings → Registry credentials) or make the package public.
- Same variables, domain and volume steps as above.

`ghcr.io/tiarabasori/opencode2api:latest` also exists (upstream), but it does
not contain the proxy-pool feature.

## 2. Relay service (optional)

1. **New Service → Deploy from GitHub repo** → same fork.
2. **Settings → Source → Root Directory**: `relay/railway`.
3. Variables: `RELAY_TOKEN` (optional), or `RELAY_OPENAI_BASE` /
   `RELAY_ANTHROPIC_BASE` / `RELAY_GOOGLE_BASE` when not forwarding to Zen.
4. **Generate Domain** → `https://relay-xxxx.up.railway.app`.
5. Add it to the proxy's `OPENCODE_PROXY_POOL` and redeploy the proxy.

A relay in the same project/region shares the proxy's egress IPs: it adds
failover, not IP rotation. Use another region/project or another platform
(Vercel/Cloudflare/Netlify/Deno) when you need a distinct egress.

## Sizing

| Pool entries | Processes | Memory to plan for |
|---|---|---|
| 1 | 1 × `opencode serve` | ~1 GB |
| 2 | 2 | ~2 GB |
| 4 | 4 | ~3–4 GB |

The relay service is tiny (a Node HTTP forwarder); 256 MB is plenty.

## Verify

```bash
curl https://<proxy-domain>/health
# {"status":"ok","proxy":true}

curl -H "Authorization: Bearer $API_KEY" https://<proxy-domain>/v1/models
curl -H "Authorization: Bearer $API_KEY" https://<proxy-domain>/health/details   # .pool
curl -H "Authorization: Bearer $API_KEY" https://<proxy-domain>/metrics | grep opencode_pool
```

## Gotchas

- **Do not set `OPENCODE_PROXY_PORT`.** Railway injects `PORT`; the proxy reads
  it. Setting the former wins over `PORT` and the domain will return 502.
- **Do not set `OPENCODE_SERVER_URL` to another service.** Backends are child
  processes in this container and must stay on `127.0.0.1:10001+`.
- **`API_KEY` is mandatory on a public domain** — without it the proxy accepts
  anyone. The panel and metrics endpoints use the same key.
- **First boot is slow** (OpenCode starts on the first request); the health
  endpoint answers immediately, so Railway's probe succeeds.
- The container runs as root and drops to `node` via `gosu`; a mounted volume
  is re-chowned on start. If you force a non-root container user, the entrypoint
  cannot switch users.
