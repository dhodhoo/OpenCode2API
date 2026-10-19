/**
 * OpenCode2API relay — Vercel Edge Function.
 *
 * Forwards to the OpenCode Zen endpoint that matches the request path:
 *   /messages            → anthropic  (Claude-style models)
 *   /models/x:generate…  → google     (Gemini-style models)
 *   everything else      → openai     (default; all free models)
 *
 * Configure with environment variables:
 *   RELAY_OPENAI_BASE     default https://opencode.ai/inference/openai/v1
 *   RELAY_ANTHROPIC_BASE  default https://opencode.ai/inference/anthropic/v1
 *   RELAY_GOOGLE_BASE     default https://opencode.ai/inference/google/v1beta
 *   RELAY_TOKEN           optional shared secret, required in x-relay-token
 */

export const config = { runtime: 'edge' };

// vercel.json rewrites /(.*) to /api/relay/$1, so the original request path is
// appended here and has to be stripped before routing.
const PATH_PREFIX = '/api/relay';

const OPENAI_BASE = process.env.RELAY_OPENAI_BASE || 'https://opencode.ai/inference/openai/v1';
const ANTHROPIC_BASE = process.env.RELAY_ANTHROPIC_BASE || 'https://opencode.ai/inference/anthropic/v1';
const GOOGLE_BASE = process.env.RELAY_GOOGLE_BASE || 'https://opencode.ai/inference/google/v1beta';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

const HOP_BY_HOP = Object.freeze({
  host: true,
  connection: true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
  // fetch already decompressed the body; forwarding these breaks clients
  'content-encoding': true,
  'content-length': true
});

function upstreamBase(pathname) {
  if (pathname === '/messages' || pathname.startsWith('/messages/')) return ANTHROPIC_BASE;
  if (/:(stream)?generatecontent/i.test(pathname)) return GOOGLE_BASE;
  return OPENAI_BASE;
}

function originalPath(url, relayPathHeader) {
  if (relayPathHeader) return relayPathHeader.startsWith('/') ? relayPathHeader : `/${relayPathHeader}`;
  const pathname = url.pathname.startsWith(PATH_PREFIX)
    ? url.pathname.slice(PATH_PREFIX.length) || '/'
    : url.pathname;
  return pathname + url.search;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = originalPath(url, req.headers.get('x-relay-path'));

  if (path === '/health') {
    return new Response(JSON.stringify({ ok: true, relay: 'vercel' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (RELAY_TOKEN && req.headers.get('x-relay-token') !== RELAY_TOKEN) {
    return new Response(JSON.stringify({ error: 'invalid relay token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }

  const target = upstreamBase(path) + path;

  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP[lower] || lower === 'x-relay-token' || lower === 'x-relay-path') continue;
    headers.set(key, value);
  }

  const init = { method: req.method, headers, redirect: 'follow' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP[key.toLowerCase()]) continue;
    responseHeaders.set(key, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
