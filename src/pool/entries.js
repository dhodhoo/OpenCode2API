/**
 * Proxy-pool entry parsing and per-entry backend environment.
 *
 * A pool entry is one OpenCode backend instance plus the egress path it uses
 * for upstream (OpenCode Zen) traffic:
 *
 *   direct — no override, the backend uses the host network as before
 *   relay  — provider baseURL points at an HTTP relay (Vercel/Cloudflare/
 *            Netlify/Deno) that forwards to Zen, so the request leaves from
 *            the relay's network
 *   proxy  — HTTP_PROXY/HTTPS_PROXY point at an HTTP(S) proxy, so the request
 *            leaves from the proxy's network
 *
 * The relay form is the only one that works on edge platforms: they cannot
 * speak the CONNECT method an HTTP proxy needs for TLS.
 */

export const POOL_ENTRY_TYPES = Object.freeze(['direct', 'relay', 'proxy']);


const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';
const PROXY_SCHEMES = new Set(['http:', 'https:']);
const RELAY_SCHEMES = new Set(['http:', 'https:']);

export class PoolConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PoolConfigError';
    }
}

function normalizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * Accept `host:port`, `user:pass@host:port`, and full URLs. Credentials with
 * special characters must be percent-encoded, exactly like any proxy URL.
 */
export function normalizeProxyUrl(value) {
    const raw = normalizeString(value);
    if (!raw) throw new PoolConfigError('pool entry "proxy" requires a url');
    if (/[\s]/.test(raw)) throw new PoolConfigError(`invalid proxy url "${raw}": contains whitespace`);
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch (e) {
        throw new PoolConfigError(`invalid proxy url "${raw}": ${e.message}`);
    }
    if (!PROXY_SCHEMES.has(parsed.protocol)) {
        throw new PoolConfigError(`invalid proxy url "${raw}": only http:// and https:// proxies are supported`);
    }
    if (!parsed.hostname) throw new PoolConfigError(`invalid proxy url "${raw}": missing host`);
    if (!parsed.port) throw new PoolConfigError(`invalid proxy url "${raw}": missing port`);
    return parsed.href;
}

export function normalizeRelayUrl(value) {
    const raw = normalizeString(value);
    if (!raw) throw new PoolConfigError('pool entry "relay" requires a url');
    if (/\s/.test(raw)) throw new PoolConfigError(`invalid relay url "${raw}": contains whitespace`);
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (e) {
        throw new PoolConfigError(`invalid relay url "${raw}": ${e.message}`);
    }
    if (!RELAY_SCHEMES.has(parsed.protocol)) {
        throw new PoolConfigError(`invalid relay url "${raw}": only http:// and https:// relays are supported`);
    }
    if (parsed.search || parsed.hash) {
        throw new PoolConfigError(`invalid relay url "${raw}": must not contain a query or fragment`);
    }
    return parsed.href.replace(/\/+$/, '');
}

/**
 * The proxy owns one port per entry, derived from the configured backend URL so
 * an operator who already moved the backend off 10001 keeps the same base.
 */
export function backendUrlFor(baseServerUrl, index) {
    let parsed;
    try {
        parsed = new URL(baseServerUrl || 'http://127.0.0.1:10001');
    } catch (e) {
        throw new PoolConfigError(`invalid OPENCODE_SERVER_URL "${baseServerUrl}": ${e.message}`);
    }
    const basePort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65535) {
        throw new PoolConfigError(`invalid port in OPENCODE_SERVER_URL "${baseServerUrl}"`);
    }
    const port = basePort + index;
    if (port > 65535) {
        throw new PoolConfigError(`pool entry ${index} would need port ${port}; move OPENCODE_SERVER_URL to a lower port`);
    }
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

/**
 * Normalize the PROXY_POOL / OPENCODE_PROXY_POOL value into backend entries.
 *
 * Returns [] when unset, which keeps the single-backend behavior intact.
 * Throws on malformed input so a bad pool fails at startup, not per request.
 *
 * @param {*} raw - array (config.json) or JSON string (env)
 * @param {{baseServerUrl?: string}} [options]
 * @returns {Array<{id:string,name:string,type:string,index:number,serverUrl:string,proxyUrl:string|null,relayUrl:string|null}>}
 */
export function parsePoolEntries(raw, options = {}) {
    if (raw === undefined || raw === null || raw === '') return [];
    let list = raw;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        try {
            list = JSON.parse(trimmed);
        } catch (e) {
            throw new PoolConfigError(`OPENCODE_PROXY_POOL must be a JSON array: ${e.message}`);
        }
    }
    if (!Array.isArray(list)) {
        throw new PoolConfigError('PROXY_POOL must be an array of entries');
    }
    if (list.length === 0) return [];
    if (list.length > 32) {
        throw new PoolConfigError(`PROXY_POOL has ${list.length} entries; the maximum is 32`);
    }

    const baseServerUrl = options.baseServerUrl || 'http://127.0.0.1:10001';
    const seenNames = new Set();

    return list.map((rawEntry, index) => {
        if (typeof rawEntry === 'string') {
            // Bare strings are the shorthand for a proxy URL: "user:pass@host:port".
            rawEntry = { type: 'proxy', url: rawEntry };
        }
        if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
            throw new PoolConfigError(`PROXY_POOL[${index}] must be an object`);
        }
        const type = normalizeString(rawEntry.type || 'direct').toLowerCase();
        if (!POOL_ENTRY_TYPES.includes(type)) {
            throw new PoolConfigError(`PROXY_POOL[${index}] has unknown type "${type}" (expected ${POOL_ENTRY_TYPES.join(', ')})`);
        }
        const name = normalizeString(rawEntry.name) || `entry-${index}`;
        if (seenNames.has(name)) {
            throw new PoolConfigError(`PROXY_POOL has duplicate entry name "${name}"`);
        }
        seenNames.add(name);

        let proxyUrl = null;
        let relayUrl = null;
        if (type === 'proxy') proxyUrl = normalizeProxyUrl(rawEntry.url);
        if (type === 'relay') relayUrl = normalizeRelayUrl(rawEntry.url);

        return {
            id: name,
            name,
            type,
            index,
            serverUrl: backendUrlFor(baseServerUrl, index),
            proxyUrl,
            relayUrl
        };
    });
}

/**
 * Environment overrides for one backend instance. Returns {} for direct
 * entries so the backend inherits the proxy process environment unchanged.
 */
export function buildEntryBackendEnv(entry, baseEnv = {}) {
    if (!entry || entry.type === 'direct') return {};
    if (entry.type === 'proxy') {
        const noProxy = normalizeString(baseEnv.NO_PROXY || baseEnv.no_proxy);
        return {
            HTTP_PROXY: entry.proxyUrl,
            HTTPS_PROXY: entry.proxyUrl,
            ALL_PROXY: entry.proxyUrl,
            NO_PROXY: noProxy ? `${noProxy},${DEFAULT_NO_PROXY}` : DEFAULT_NO_PROXY
        };
    }
    if (entry.type === 'relay') {
        return {
            OPENCODE_CONFIG_CONTENT: mergeRelayProviderConfig(baseEnv.OPENCODE_CONFIG_CONTENT, entry.relayUrl)
        };
    }
    return {};
}

/**
 * Point the `opencode` provider at the relay. The provider-level baseURL
 * applies to every Zen model (verified against opencode 1.19.3: the ai-sdk
 * appends only the protocol path, e.g. /chat/completions or /messages), so the
 * relay decides the upstream family from that path.
 */
export function mergeRelayProviderConfig(existing, relayUrl) {
    let base = {};
    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
        } catch (e) {
            // Leave a malformed operator value alone; the backend reports it.
            base = {};
        }
    }
    const provider = (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider))
        ? { ...base.provider }
        : {};
    const opencode = (provider.opencode && typeof provider.opencode === 'object' && !Array.isArray(provider.opencode))
        ? { ...provider.opencode }
        : {};
    const options = (opencode.options && typeof opencode.options === 'object' && !Array.isArray(opencode.options))
        ? { ...opencode.options }
        : {};
    options.baseURL = relayUrl;
    opencode.options = options;
    provider.opencode = opencode;
    return JSON.stringify({ ...base, provider });
}
