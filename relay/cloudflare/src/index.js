/**
 * OpenCode2API relay — Cloudflare Worker.
 *
 * Forwards to the OpenCode Zen endpoint that matches the request path:
 *   /messages            → anthropic
 *   /models/x:generate…  → google
 *   everything else      → openai
 *
 * Bindings (wrangler.toml [vars] or dashboard):
 *   RELAY_OPENAI_BASE / RELAY_ANTHROPIC_BASE / RELAY_GOOGLE_BASE
 *   RELAY_TOKEN          optional shared secret, required in x-relay-token
 *   RELAY_PATH_PREFIX    optional, when the worker is mounted under a path
 */

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
  'content-encoding': true,
  'content-length': true
});

function upstreamBase(pathname, env) {
  const openai = env.RELAY_OPENAI_BASE || 'https://opencode.ai/inference/openai/v1';
  const anthropic = env.RELAY_ANTHROPIC_BASE || 'https://opencode.ai/inference/anthropic/v1';
  const google = env.RELAY_GOOGLE_BASE || 'https://opencode.ai/inference/google/v1beta';
  if (pathname === '/messages' || pathname.startsWith('/messages/')) return anthropic;
  if (/:(stream)?generatecontent/i.test(pathname)) return google;
  return openai;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headerPath = request.headers.get('x-relay-path');
    const prefix = env.RELAY_PATH_PREFIX || '';
    let path = headerPath || url.pathname;
    if (!headerPath) {
      if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
      path += url.search;
    }

    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true, relay: 'cloudflare' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (env.RELAY_TOKEN && request.headers.get('x-relay-token') !== env.RELAY_TOKEN) {
      return new Response(JSON.stringify({ error: 'invalid relay token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }

    const target = upstreamBase(path, env) + path;
    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP[lower] || lower === 'x-relay-token' || lower === 'x-relay-path') continue;
      headers.set(key, value);
    }

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
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
};
