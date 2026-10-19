import { jest } from '@jest/globals';
import {
    parsePoolEntries,
    buildEntryBackendEnv,
    mergeRelayProviderConfig,
    normalizeProxyUrl,
    normalizeRelayUrl,
    backendUrlFor,
    PoolConfigError
} from '../../src/pool/entries.js';
import { createPoolScheduler } from '../../src/pool/scheduler.js';

describe('pool entry parsing', () => {
    test('unset pool keeps single-backend behavior', () => {
        expect(parsePoolEntries(undefined)).toEqual([]);
        expect(parsePoolEntries('')).toEqual([]);
        expect(parsePoolEntries([])).toEqual([]);
    });

    test('accepts a JSON string (env) and assigns one port per entry', () => {
        const entries = parsePoolEntries(
            '[{"name":"direct","type":"direct"},{"name":"relay","type":"relay","url":"https://relay.example.com/"}]',
            { baseServerUrl: 'http://127.0.0.1:10001' }
        );
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ id: 'direct', type: 'direct', serverUrl: 'http://127.0.0.1:10001' });
        expect(entries[1]).toMatchObject({ id: 'relay', type: 'relay', serverUrl: 'http://127.0.0.1:10002' });
        expect(entries[1].relayUrl).toBe('https://relay.example.com');
    });

    test('bare strings are proxy URLs in user:pass@host:port form', () => {
        const [entry] = parsePoolEntries(['user:p%40ss@10.0.0.1:8080']);
        expect(entry.type).toBe('proxy');
        expect(entry.proxyUrl).toBe('http://user:p%40ss@10.0.0.1:8080/');
    });

    test('rejects malformed entries instead of starting with a broken pool', () => {
        expect(() => parsePoolEntries([{ type: 'relay' }])).toThrow(PoolConfigError);
        expect(() => parsePoolEntries([{ type: 'proxy', url: '10.0.0.1' }])).toThrow(/missing port/);
        expect(() => parsePoolEntries([{ type: 'socks', url: '1.2.3.4:1' }])).toThrow(/unknown type/);
        expect(() => parsePoolEntries('[{"type":"direct"},{"type":"direct","name":"entry-0"}]')).toThrow(/duplicate/);
        expect(() => parsePoolEntries('not json')).toThrow(/JSON array/);
    });

    test('normalizes proxy and relay URLs', () => {
        expect(normalizeProxyUrl('http://u:p@host:3128')).toBe('http://u:p@host:3128/');
        expect(normalizeRelayUrl('https://relay.example.com/base/')).toBe('https://relay.example.com/base');
        expect(() => normalizeRelayUrl('https://relay.example.com?x=1')).toThrow(/query or fragment/);
        expect(() => normalizeProxyUrl('socks5://host:1080')).toThrow(/only http/);
    });

    test('refuses a pool that would run past the port range', () => {
        expect(() => backendUrlFor('http://127.0.0.1:65535', 1)).toThrow(/lower port/);
    });
});

describe('pool backend environment', () => {
    const baseEnv = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
            plugin: ['/abs/tool-lock.js'],
            provider: { opencode: { options: { apiKey: 'zen-key' } } },
            theme: 'dark'
        })
    };

    test('direct entries add nothing', () => {
        expect(buildEntryBackendEnv({ type: 'direct' }, baseEnv)).toEqual({});
    });

    test('proxy entries set the standard proxy variables and bypass loopback', () => {
        const env = buildEntryBackendEnv(
            { type: 'proxy', proxyUrl: 'http://u:p@10.0.0.1:8080/' },
            { ...baseEnv, NO_PROXY: 'internal.example.com' }
        );
        expect(env).toMatchObject({
            HTTP_PROXY: 'http://u:p@10.0.0.1:8080/',
            HTTPS_PROXY: 'http://u:p@10.0.0.1:8080/',
            ALL_PROXY: 'http://u:p@10.0.0.1:8080/'
        });
        expect(env.NO_PROXY).toContain('internal.example.com');
        expect(env.NO_PROXY).toContain('127.0.0.1');
        expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });

    test('relay entries point the opencode provider at the relay and keep other config', () => {
        const env = buildEntryBackendEnv({ type: 'relay', relayUrl: 'https://relay.example.com' }, baseEnv);
        const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
        expect(parsed.provider.opencode.options).toEqual({
            apiKey: 'zen-key',
            baseURL: 'https://relay.example.com'
        });
        expect(parsed.plugin).toEqual(['/abs/tool-lock.js']);
        expect(parsed.theme).toBe('dark');
    });

    test('relay merge tolerates a malformed operator config', () => {
        const parsed = JSON.parse(mergeRelayProviderConfig('{not json', 'https://relay.example.com'));
        expect(parsed.provider.opencode.options.baseURL).toBe('https://relay.example.com');
    });
});

describe('pool scheduler', () => {
    const entries = parsePoolEntries([
        { name: 'a', type: 'direct' },
        { name: 'b', type: 'direct' },
        { name: 'c', type: 'direct' }
    ]);

    test('round-robin rotates across entries', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin' });
        expect(scheduler.select().id).toBe('a');
        expect(scheduler.select().id).toBe('b');
        expect(scheduler.select().id).toBe('c');
        expect(scheduler.select().id).toBe('a');
    });

    test('affinity wins while the entry is eligible', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin' });
        expect(scheduler.select({ affinityId: 'c' }).id).toBe('c');
        expect(scheduler.select({ affinityId: 'c' }).id).toBe('c');
    });

    test('a failed entry is skipped until its cooldown expires', () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin', failureCooldownMs: 10_000 });
        scheduler.markFailure(entries[0], new Error('relay 502'));
        expect(scheduler.select().id).toBe('b');
        expect(scheduler.select().id).toBe('c');
        expect(scheduler.select({ affinityId: 'a' }).id).toBe('b');
        now.mockReturnValue(1_020_000);
        expect(scheduler.select({ affinityId: 'a' }).id).toBe('a');
        scheduler.markSuccess(entries[0]);
        expect(scheduler.snapshot()[0]).toMatchObject({ status: 'healthy', totalFailures: 1, lastError: null });
        now.mockRestore();
    });

    test('least-connections prefers the idle entry', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'least-connections' });
        scheduler.acquire(entries[0]);
        scheduler.acquire(entries[0]);
        scheduler.acquire(entries[1]);
        expect(scheduler.select().id).toBe('c');
        scheduler.release(entries[0]);
        scheduler.release(entries[0]);
        scheduler.release(entries[1]);
        expect(scheduler.select().id).toBe('a');
    });

    test('exclude skips entries already tried by this request', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin' });
        expect(scheduler.select({ exclude: ['a', 'b'] }).id).toBe('c');
    });

    test('select returns null when every entry is cooling down', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin', failureCooldownMs: 60000 });
        entries.forEach((entry) => scheduler.markFailure(entry, new Error('down')));
        expect(scheduler.select()).toBeNull();
        expect(scheduler.snapshot().every((row) => row.eligible === false)).toBe(true);
    });

    test('snapshot reports routing counters per entry', () => {
        const scheduler = createPoolScheduler(entries, { strategy: 'round-robin' });
        scheduler.acquire(entries[1]);
        scheduler.markFailure(entries[1], new Error('boom'));
        const row = scheduler.snapshot()[1];
        expect(row).toMatchObject({
            name: 'b',
            type: 'direct',
            status: 'unhealthy',
            inFlight: 1,
            totalRequests: 1,
            totalFailures: 1,
            lastError: 'boom'
        });
        expect(row.serverUrl).toBe('http://127.0.0.1:10002');
    });
});
