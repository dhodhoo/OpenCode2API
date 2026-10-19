/**
 * OpenCode2API relay — Deno Deploy.
 *
 * Deno.serve keeps the original path, so the handler routes on it directly:
 *   /messages            → anthropic
 *   /models/x:generate…  → google
 *   everything else      → openai
 *
 * Environment variables (Deno Deploy dashboard or `deno run --env-file`):
 *   RELAY_OPENAI_BASE / RELAY_ANTHROPIC_BASE / RELAY_GOOGLE_BASE
 *   RELAY_TOKEN          optional shared secret, required in x-relay-token
 */

const HOP_BY_HOP: Record<string, true> = {
  host: true,
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  "content-encoding": true,
  "content-length": true,
};

function env(name: string, fallback: string): string {
  try {
    return Deno.env.get(name) || fallback;
  } catch {
    return fallback;
  }
}

function upstreamBase(pathname: string): string {
  if (pathname === "/messages" || pathname.startsWith("/messages/")) {
    return env("RELAY_ANTHROPIC_BASE", "https://opencode.ai/inference/anthropic/v1");
  }
  if (/:(stream)?generatecontent/i.test(pathname)) {
    return env("RELAY_GOOGLE_BASE", "https://opencode.ai/inference/google/v1beta");
  }
  return env("RELAY_OPENAI_BASE", "https://opencode.ai/inference/openai/v1");
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headerPath = request.headers.get("x-relay-path");
  let path = headerPath || url.pathname;
  if (!headerPath) path += url.search;

  if (path === "/health") {
    return new Response(JSON.stringify({ ok: true, relay: "deno" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const token = env("RELAY_TOKEN", "");
  if (token && request.headers.get("x-relay-token") !== token) {
    return new Response(JSON.stringify({ error: "invalid relay token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const target = upstreamBase(path) + path;
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP[lower] || lower === "x-relay-token" || lower === "x-relay-path") continue;
    headers.set(key, value);
  }

  // `duplex` is required for streaming request bodies but missing from the
  // lib.dom RequestInit type.
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "follow" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP[key.toLowerCase()]) continue;
    responseHeaders.set(key, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

Deno.serve(handler);
