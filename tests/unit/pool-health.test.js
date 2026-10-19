import http from 'node:http';
import net from 'node:net';
import { startPoolHealthProbes } from '../../src/pool/health.js';
import { createPoolScheduler } from '../../src/pool/scheduler.js';
import { parsePoolEntries } from '../../src/pool/entries.js';

const silentLogger = { log() { }, warn() { } };

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('pool health probes', () => {
    test('a relay that answers any status is reachable; a closed port is not', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"error":"no health route"}');
        });
        const port = await listen(server);

        const entries = parsePoolEntries(
            [{ name: 'relay', type: 'relay', url: `http://127.0.0.1:${port}` }],
            { baseServerUrl: 'http://127.0.0.1:10001' }
        );
        const scheduler = createPoolScheduler(entries);
        const probes = startPoolHealthProbes({ entries, scheduler, timeoutMs: 2000, logger: silentLogger });

        await probes.probeNow();
        expect(scheduler.snapshot()[0]).toMatchObject({ status: 'healthy', eligible: true });

        await new Promise((resolve) => server.close(resolve));
        await probes.probeNow();
        expect(scheduler.snapshot()[0].status).toBe('unhealthy');
        expect(scheduler.snapshot()[0].eligible).toBe(false);
        probes.stop();
    });

    test('a proxy entry is probed with a TCP connect', async () => {
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => { });
        });
        const port = await listen(server);

        const entries = parsePoolEntries(
            [{ name: 'proxy', type: 'proxy', url: `127.0.0.1:${port}` }],
            { baseServerUrl: 'http://127.0.0.1:10001' }
        );
        const scheduler = createPoolScheduler(entries);
        const probes = startPoolHealthProbes({ entries, scheduler, timeoutMs: 2000, logger: silentLogger });

        await probes.probeNow();
        expect(scheduler.snapshot()[0].status).toBe('healthy');

        probes.stop();
        await new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(resolve);
        });
    });

    test('direct entries are not probed', () => {
        const entries = parsePoolEntries([{ name: 'a', type: 'direct' }]);
        const scheduler = createPoolScheduler(entries);
        const probes = startPoolHealthProbes({ entries, scheduler, logger: silentLogger });
        expect(scheduler.snapshot()[0].status).toBe('unknown');
        probes.stop();
    });
});
