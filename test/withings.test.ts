import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TokenStore } from '../src/withings/store.js';
import { WithingsClient } from '../src/withings/client.js';
import { createServer } from '../src/server.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'withings-'));
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  return new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
}

function tokens(id = 'wu1') {
  return { withingsUserId: id, accessToken: 'a', refreshToken: 'r', accessExpiresAt: Date.now() + 3_600_000, scope: 's', connectedAt: Date.now() };
}

describe('TokenStore', () => {
  it('encrypts at rest and round-trips per user, keyed case-insensitively', () => {
    const s = store();
    s.setTokens('ABO@borgels.com', tokens('wu42'));
    expect(s.getTokens('abo@borgels.com')?.withingsUserId).toBe('wu42');
    // raw file must not contain the plaintext token
    const raw = require('node:fs').readFileSync(join(dir, 'store.json'), 'utf8');
    expect(raw).not.toContain('wu42');
    expect(raw).toContain('iv');
  });

  it('states are single-use and bound to a user', () => {
    const s = store();
    const st = s.createState('me@x.dk');
    expect(s.consumeState(st)).toBe('me@x.dk');
    expect(s.consumeState(st)).toBeUndefined(); // consumed
    expect(s.consumeState('bogus')).toBeUndefined();
  });

  it('rejects a weak encryption key', () => {
    expect(() => new TokenStore({ path: join(dir, 's.json'), encryptionKey: 'short' })).toThrow('WITHINGS_ENCRYPTION_KEY');
  });

  it('persists across instances', () => {
    store().setTokens('u@x.dk', tokens('persisted'));
    expect(store().getTokens('u@x.dk')?.withingsUserId).toBe('persisted');
  });
});

describe('WithingsClient token flow', () => {
  function client(handler: (body: URLSearchParams) => unknown) {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return new WithingsClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/withings/callback', fetchImpl });
  }

  it('exchanges a code and parses the status:0 body', async () => {
    const c = client(() => ({ status: 0, body: { userid: 7, access_token: 'AT', refresh_token: 'RT', expires_in: 10800, scope: 'user.info' } }));
    const t = await c.exchangeCode('code123');
    expect(t.withingsUserId).toBe('7');
    expect(t.accessToken).toBe('AT');
  });

  it('refreshes with rotation and persists the new refresh token', async () => {
    const s = store();
    s.setTokens('u@x.dk', { ...tokens(), accessExpiresAt: Date.now() - 1000, refreshToken: 'OLD' });
    let seenRefresh = '';
    const c = client(body => {
      seenRefresh = body.get('refresh_token') ?? '';
      return { status: 0, body: { userid: 1, access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 10800 } };
    });
    const at = await c.validAccessToken('u@x.dk', s);
    expect(at).toBe('NEW_AT');
    expect(seenRefresh).toBe('OLD');
    expect(s.getTokens('u@x.dk')?.refreshToken).toBe('NEW_RT'); // rotation persisted
  });

  it('throws on Withings error status', async () => {
    const c = client(() => ({ status: 601 }));
    await expect(c.exchangeCode('x')).rejects.toThrow();
  });
});

describe('per-user isolation via MCP', () => {
  async function connect(onBehalfOf?: string) {
    process.env.WITHINGS_CLIENT_ID = 'c';
    process.env.WITHINGS_CLIENT_SECRET = 's';
    process.env.WITHINGS_REDIRECT_URI = 'https://withings.me.mcp.borgels.com/withings/callback';
    const s = store();
    const c = new WithingsClient();
    const server = createServer({ client: c, store: s, onBehalfOf });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return { mcp, store: s };
  }

  it('data tools fail closed without a verified identity', async () => {
    const { mcp } = await connect(undefined);
    const r = await mcp.callTool({ name: 'withings_get_measures', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]?.text).toContain('X-MCP-User');
  });

  it('a not-enrolled user is told to connect, never gets data', async () => {
    const { mcp } = await connect('nobody@x.dk');
    const r = await mcp.callTool({ name: 'withings_get_measures', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]?.text).toContain('NOT_ENROLLED');
  });

  it('connect returns a single-use authorization URL bound to the user', async () => {
    const { mcp, store: s } = await connect('me@x.dk');
    const r = await mcp.callTool({ name: 'withings_connect', arguments: {} });
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '{}');
    const state = new URL(out.authorizationUrl).searchParams.get('state')!;
    expect(s.consumeState(state)).toBe('me@x.dk');
  });

  it('write tools are gated on WITHINGS_ENABLE_WRITES', async () => {
    delete process.env.WITHINGS_ENABLE_WRITES;
    const { mcp, store: s } = await connect('me@x.dk');
    s.setTokens('me@x.dk', tokens());
    const r = await mcp.callTool({ name: 'withings_add_measure', arguments: { type: 1, value: 80 } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]?.text).toContain('disabled');
  });
});
