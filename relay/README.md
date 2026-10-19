# Relay deployments

The proxy pool can send upstream traffic through an HTTP relay instead of the
host network. A relay is a tiny forwarder you deploy to an edge platform, so
OpenCode Zen sees the platform's egress IP rather than yours.

Four ready-to-deploy templates live in this directory:

| Platform | Entry point | Deploy |
|---|---|---|
| Vercel | `vercel/api/relay.js` | `vercel deploy --prod` in `relay/vercel` |
| Cloudflare Workers | `cloudflare/src/index.js` | `wrangler deploy` in `relay/cloudflare` |
| Netlify | `netlify/netlify/functions/relay.mjs` | `netlify deploy --prod` in `relay/netlify` |
| Deno Deploy | `deno/main.ts` | `deployctl deploy --project=... deno/main.ts` |

## How it works

`opencode` appends only the protocol path to the provider base URL
(`/chat/completions`, `/messages`, `/models/<id>:generateContent`). The relay
therefore routes by path shape:

| Request path | Upstream |
|---|---|
| `/messages` | `RELAY_ANTHROPIC_BASE` (default `https://opencode.ai/inference/anthropic/v1`) |
| `/models/<id>:generateContent` | `RELAY_GOOGLE_BASE` (default `https://opencode.ai/inference/google/v1beta`) |
| anything else | `RELAY_OPENAI_BASE` (default `https://opencode.ai/inference/openai/v1`) |

Streaming responses are passed through as-is, so SSE works. `Authorization` and
all other end-to-end headers are preserved; hop-by-hop headers are dropped.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `RELAY_OPENAI_BASE` | no | OpenAI-compatible upstream base |
| `RELAY_ANTHROPIC_BASE` | no | Anthropic-compatible upstream base |
| `RELAY_GOOGLE_BASE` | no | Google-compatible upstream base |
| `RELAY_TOKEN` | no | When set, requests must carry `x-relay-token: <value>` |
| `RELAY_PATH_PREFIX` | no | Cloudflare only: strip a mount prefix |

`GET /health` on the relay answers `{"ok":true,...}` without forwarding, so you
can point an uptime check at it.

## Wiring a relay into the proxy

```json
{
  "POOL": [
    { "name": "direct", "type": "direct" },
    { "name": "vercel", "type": "relay", "url": "https://relay-xxxx.vercel.app" },
    { "name": "jkt", "type": "proxy", "url": "http://user:pass@10.0.0.1:8080" }
  ],
  "POOL_STRATEGY": "round-robin"
}
```

Each entry spawns its own `opencode serve` instance (ports follow
`OPENCODE_SERVER_URL`, e.g. 10001, 10002, 10003). Requests are distributed
round-robin or by least-connections; a conversation stays pinned to the backend
that owns its session.

If you set `RELAY_TOKEN`, the backend also needs the header. Add it to the
provider config the proxy merges in (`OPENCODE_CONFIG_CONTENT`) or drop the
token and rely on the unguessable deployment URL.

## Notes

- Free Zen models all use the OpenAI-compatible endpoint, so a relay mostly
  exercises the first row of the routing table.
- Edge platforms have their own request limits; a relay is a load-balancing and
  IP-rotation tool, not a way around provider terms.
- Relays cannot tunnel TLS (no `CONNECT`), which is why a relay rewrites the
  base URL instead of acting as a proxy. Use `type: "proxy"` when you have a
  real HTTP proxy with credentials.
