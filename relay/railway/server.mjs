/**
 * OpenCode2API relay — Railway (plain Node service).
 *
 * Railway runs long-lived containers, not edge functions, so this variant is a
 * small HTTP server instead of a `fetch` handler. Same routing as the other
 * templates:
 *   /messages            → anthropic
 *   /models/x:generate…  → google
 *   everything else      → openai
 *
 * Environment:
 *   PORT                  injected by Railway (default 8080)
 *   RELAY_OPENAI_BASE     default https://opencode.ai/inference/openai/v1
 *   RELAY_ANTHROPIC_BASE  default https://opencode.ai/inference/anthropic/v1
 *   RELAY_GOOGLE_BASE     default https://opencode.ai/inference/google/v1beta
 *   RELAY_TOKEN           optional shared secret, required in x-relay-token
 *   RELAY_PATH_PREFIX     optional, strip a mount prefix from the path
 */

import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const OPENAI_BASE = process.env.RELAY_OPENAI_BASE || 'https://opencode.ai/inference/openai/v1';
const ANTHROPIC_BASE = process.env.RELAY_ANTHROPIC_BASE || 'https://opencode.ai/inference/anthropic/v1';
const GOOGLE_BASE = process.env.RELAY_GOOGLE_BASE || 'https://opencode.ai/inference/google/v1beta';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const PATH_PREFIX = process.env.RELAY_PATH_PREFIX || '';

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
    let pathname = url.pathname;
    if (PATH_PREFIX && pathname.startsWith(PATH_PREFIX)) pathname = pathname.slice(PATH_PREFIX.length) || '/';
    return pathname + url.search;
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (error) {
        sendJson(res, 400, { error: `invalid request url: ${error.message}` });
        return;
    }
    const path = originalPath(url, req.headers['x-relay-path']);

    if (path === '/health') {
        sendJson(res, 200, { ok: true, relay: 'railway' });
        return;
    }
    if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) {
        sendJson(res, 401, { error: 'invalid relay token' });
        return;
    }

    const target = upstreamBase(path) + path;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP[lower] || lower === 'x-relay-token' || lower === 'x-relay-path') continue;
        headers[key] = value;
    }

    const init = { method: req.method, headers, redirect: 'follow' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
    }

    try {
        const upstream = await fetch(target, init);
        const responseHeaders = {};
        for (const [key, value] of upstream.headers.entries()) {
            if (HOP_BY_HOP[key.toLowerCase()]) continue;
            responseHeaders[key] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (!upstream.body || req.method === 'HEAD') {
            res.end();
            return;
        }
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
        if (!res.headersSent) sendJson(res, 502, { error: `upstream request failed: ${error.message}` });
        else res.destroy(error);
    }
});

server.listen(PORT, HOST, () => {
    console.log(`relay listening on http://${HOST}:${PORT}`);
});
