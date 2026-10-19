import request from 'supertest';
import { jest } from '@jest/globals';

// Two backends, one client per base URL, so routing is observable.
const clients = new Map();

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            callback({
                statusCode: 200,
                headers: {},
                on: jest.fn((event, handler) => {
                    if (event === 'end') handler();
                })
            });
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            callback({
                statusCode: 200,
                headers: {},
                resume: jest.fn(),
                setEncoding: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler('{"healthy":true}');
                    if (event === 'end') handler();
                })
            });
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(({ baseUrl }) => {
        const client = {
            baseUrl,
            config: {
                providers: jest.fn(async () => ({
                    data: {
                        providers: [
                            { id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi', release_date: '2025-01-01' } } }
                        ]
                    }
                })),
                update: jest.fn(async () => ({})),
                get: jest.fn(async () => ({ data: { plugin: [] } }))
            },
            tool: { ids: jest.fn(async () => ({ data: ['webfetch'] })) },
            session: {
                create: jest.fn(async () => ({ data: { id: `session@${baseUrl}` } })),
                prompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
                messages: jest.fn(async () => ([
                    { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] }
                ])),
                delete: jest.fn(async () => ({}))
            },
            event: {
                subscribe: jest.fn(async () => ({ stream: (async function* () { })() }))
            }
        };
        clients.set(baseUrl, client);
        return client;
    })
}));

const { createApp } = await import('../../src/proxy.js');
const { parsePoolEntries } = await import('../../src/pool/entries.js');

const POOL = parsePoolEntries(
    [{ name: 'a', type: 'direct' }, { name: 'b', type: 'direct' }],
    { baseServerUrl: 'http://127.0.0.1:10001' }
);

function buildApp(overrides = {}) {
    clients.clear();
    const config = {
        PORT: 10000,
        API_KEY: 'test-key',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: true,
        DEBUG: false,
        MANAGE_BACKEND: false,
        POOL,
        POOL_STRATEGY: 'round-robin',
        ...overrides
    };
    return createApp(config).app;
}

function chat(app, content = 'Hello') {
    return request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-key')
        .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content }] });
}

describe('proxy pool routing', () => {
    test('round-robin spreads requests across backend instances', async () => {
        const app = buildApp();
        const first = await chat(app, 'one');
        const second = await chat(app, 'two');

        expect(first.statusCode).toEqual(200);
        expect(second.statusCode).toEqual(200);

        const a = clients.get('http://127.0.0.1:10001');
        const b = clients.get('http://127.0.0.1:10002');
        expect(a.session.create).toHaveBeenCalledTimes(1);
        expect(b.session.create).toHaveBeenCalledTimes(1);
        expect(a.session.prompt).toHaveBeenCalledTimes(1);
        expect(b.session.prompt).toHaveBeenCalledTimes(1);
    });

    test('chat session affinity pins a conversation to its backend', async () => {
        const app = buildApp({ CHAT_SESSION_AFFINITY: true });
        const first = await chat(app, 'same conversation');
        const second = await chat(app, 'same conversation');

        expect(first.statusCode).toEqual(200);
        expect(second.statusCode).toEqual(200);

        const a = clients.get('http://127.0.0.1:10001');
        expect(a.session.create).toHaveBeenCalledTimes(2);
        // The second backend was never contacted, so its client was never built.
        expect(clients.has('http://127.0.0.1:10002')).toBe(false);
    });

    test('diagnostics expose per-entry health', async () => {
        const app = buildApp();
        await chat(app, 'warm');

        const res = await request(app)
            .get('/health/details')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.pool.strategy).toBe('round-robin');
        expect(res.body.pool.entries).toHaveLength(2);
        expect(res.body.pool.entries[0]).toMatchObject({
            name: 'a',
            type: 'direct',
            status: 'healthy',
            totalRequests: 1
        });
        expect(res.body.pool.entries[1].totalRequests).toBe(0);
    });

    test('metrics expose one series per pool entry', async () => {
        const app = buildApp({ METRICS_ENABLED: true });
        await chat(app, 'warm');

        const res = await request(app)
            .get('/metrics')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('opencode_pool_backend_status{name="a",type="direct"} 1');
        expect(res.text).toContain('opencode_pool_backend_requests_total{name="a",type="direct"} 1');
        expect(res.text).toContain('opencode_pool_backend_requests_total{name="b",type="direct"} 0');
    });
});
