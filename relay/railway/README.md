# Railway relay

Deploy this directory as its own Railway service:

1. Railway → **New Project → Deploy from GitHub repo**, pick your fork.
2. Service **Settings → Source → Root Directory**: `relay/railway`.
3. Builder: Dockerfile (detected from `railway.json`).
4. **Variables** (optional):
   - `RELAY_TOKEN` — shared secret; clients must send `x-relay-token`.
   - `RELAY_OPENAI_BASE` / `RELAY_ANTHROPIC_BASE` / `RELAY_GOOGLE_BASE` — only if
     you forward somewhere other than OpenCode Zen.
5. **Settings → Networking → Generate Domain**, target port = `PORT` (8080).

Health check: `GET /health` → `{"ok":true,"relay":"railway"}`.

Then register it in the proxy's pool:

```json
"POOL": [
  { "name": "direct", "type": "direct" },
  { "name": "railway", "type": "relay", "url": "https://relay-xxxx.up.railway.app" }
]
```

Note: a relay in the **same** Railway project/region as the proxy shares the
same egress IPs, so it adds failover but not IP rotation. Use a different
region, a second project, or another platform when you need a distinct egress.
