/**
 * Reachability probes for pool entries.
 *
 * Request outcomes cannot tell a dead egress path from an upstream API error:
 * an expired Zen key returns 5xx through a perfectly healthy relay. Probing the
 * path itself is deterministic — a relay answers (any status) or it does not,
 * and a proxy accepts a TCP connection or it does not.
 *
 * Direct entries are skipped: their backend health is covered by ensureBackend.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5000;

function requestRelay(relayUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(relayUrl);
        } catch (e) {
            reject(new Error(`invalid relay url: ${e.message}`));
            return;
        }
        const transport = parsed.protocol === 'https:' ? https : http;
        const target = `${parsed.origin}/health`;
        const req = transport.get(target, { timeout: timeoutMs, agent: false }, (res) => {
            res.resume();
            // Any HTTP response proves the relay is reachable; the status only
            // reflects the relay's own route table.
            resolve(res.statusCode);
        });
        req.on('timeout', () => {
            req.destroy(new Error(`relay probe timed out after ${timeoutMs}ms`));
        });
        req.on('error', (error) => reject(error));
    });
}

function connectProxy(proxyUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(proxyUrl);
        } catch (e) {
            reject(new Error(`invalid proxy url: ${e.message}`));
            return;
        }
        const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
        const socket = net.connect({ host: parsed.hostname, port });
        const finish = (error) => {
            socket.removeAllListeners();
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        socket.setTimeout(timeoutMs, () => finish(new Error(`proxy connect timed out after ${timeoutMs}ms`)));
        socket.once('connect', () => finish());
        socket.once('error', (error) => finish(error));
    });
}

/**
 * @param {{entries: Array, scheduler: object, intervalMs?: number, timeoutMs?: number, logger?: Console}} options
 * @returns {{stop: () => void, probeNow: () => Promise<void>}}
 */
export function startPoolHealthProbes(options) {
    const { entries, scheduler } = options;
    const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 30000;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const logger = options.logger || console;

    const probeTargets = entries.filter((entry) => entry.type === 'relay' || entry.type === 'proxy');
    if (probeTargets.length === 0) {
        return { stop() { }, probeNow: async () => { } };
    }

    const lastStatus = new Map();

    const probeEntry = async (entry) => {
        try {
            if (entry.type === 'relay') await requestRelay(entry.relayUrl, timeoutMs);
            else await connectProxy(entry.proxyUrl, timeoutMs);
            scheduler.markSuccess(entry);
            if (lastStatus.get(entry.id) === 'down') {
                logger.log(`[Pool] ${entry.name} (${entry.type}) reachable again`);
            }
            lastStatus.set(entry.id, 'up');
        } catch (error) {
            scheduler.markFailure(entry, error);
            if (lastStatus.get(entry.id) !== 'down') {
                logger.warn(`[Pool] ${entry.name} (${entry.type}) unreachable: ${error.message}`);
            }
            lastStatus.set(entry.id, 'down');
        }
    };

    const probeNow = async () => {
        await Promise.all(probeTargets.map((entry) => probeEntry(entry)));
    };

    probeNow().catch(() => { });
    const timer = setInterval(() => { probeNow().catch(() => { }); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        stop() { clearInterval(timer); },
        probeNow
    };
}
