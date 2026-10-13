import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/withings/store.js';
import { WithingsClient } from '../src/withings/client.js';
import { createHttpHandler, ENROLL_COOKIE } from '../src/transports/http-app.js';
import { assertAuthorized, assertSecureStartup, bearerMatches, escapeHtml, getHttpConfig } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'withings-sec-'));
});
afterEach(async () => {
  process.env = { ...originalEnv };
  if (server) await new Promise(r => server!.close(r));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('/mcp bearer', () => {
  it('refuses to start when trusting X-MCP-User without MCP_HTTP_TOKEN', () => {
    expect(() => assertSecureStartup({ WITHINGS_TRUST_FORWARDED_USER: 'true' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSecureStartup({ WITHINGS_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: '  ' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSecureStartup({ WITHINGS_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 'tok' })).not.toThrow();
    expect(() => assertSecureStartup({})).not.toThrow();
  });

  it('compares the bearer exactly', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(bearerMatches(undefined, 's3cret')).toBe(false);
    expect(bearerMatches('s3cret', 's3cret')).toBe(false);
  });

  it('rejects a forged X-MCP-User without the bearer', () => {
    const cfg = { ...getHttpConfig(), httpToken: 's3cret' };
    expect(() => assertAuthorized(req({ 'x-mcp-user': 'victim@example.com' }), cfg)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req({ authorization: 'Bearer s3cret' }), cfg)).not.toThrow();
  });

  it('fails closed when trusting X-MCP-User and no token is configured', () => {
    process.env.WITHINGS_TRUST_FORWARDED_USER = 'true';
    const cfg = { ...getHttpConfig(), httpToken: undefined };
    expect(() => assertAuthorized(req({ 'x-mcp-user': 'victim@example.com' }), cfg)).toThrow('Unauthorized');
  });
});

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});

describe('enrollment confirmation', () => {
  async function start() {
    const store = new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 0, body: { userid: 9, access_token: 'AT', refresh_token: 'RT', expires_in: 10800 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const client = new WithingsClient({
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'https://withings.me.mcp.example.com/withings/callback',
      accountBaseUrl: 'https://account.withings.invalid',
      apiBaseUrl: 'https://wbsapi.withings.invalid',
      fetchImpl,
    });
    server = createServer(createHttpHandler({ config: { ...getHttpConfig(), httpToken: 'tok' }, store, client }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { store, client, base, fetchImpl };
  }

  it('enrollment URL points at the confirmation page, not straight at Withings', () => {
    const client = new WithingsClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://withings.me.mcp.example.com/withings/callback' });
    expect(client.enrollmentUrl('abc')).toBe('https://withings.me.mcp.example.com/withings/connect?state=abc');
  });

  it('shows the bound identity (escaped) and requires confirmation before redirecting to Withings', async () => {
    const { store, base } = await start();
    const state = store.createState('<i>owner</i>@example.com');

    const page = await fetch(`${base}/withings/connect?state=${state}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('You are linking a Withings account to');
    expect(html).toContain('&lt;i&gt;owner&lt;/i&gt;@example.com');
    expect(html).not.toContain('<i>owner</i>');
    expect(html).not.toContain('account.withings.invalid');
    expect(page.headers.get('x-frame-options')).toBe('DENY');

    const noConfirm = await fetch(`${base}/withings/connect`, {
      method: 'POST',
      body: new URLSearchParams({ state }),
      redirect: 'manual',
    });
    expect(noConfirm.status).toBe(400);

    const confirmed = await fetch(`${base}/withings/connect`, {
      method: 'POST',
      body: new URLSearchParams({ state, confirm_identity: 'yes' }),
      redirect: 'manual',
    });
    expect(confirmed.status).toBe(303);
    const location = new URL(confirmed.headers.get('location')!);
    expect(location.origin).toBe('https://account.withings.invalid');
    expect(location.searchParams.get('state')).toBe(state);
    const cookie = confirmed.headers.get('set-cookie')!;
    expect(cookie).toContain(`${ENROLL_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('callback only links the account for the browser that confirmed', async () => {
    const { store, base, fetchImpl } = await start();
    const state = store.createState('owner@example.com');
    const confirmed = await fetch(`${base}/withings/connect`, {
      method: 'POST',
      body: new URLSearchParams({ state, confirm_identity: 'yes' }),
      redirect: 'manual',
    });
    const nonce = confirmed.headers.get('set-cookie')!.split(';')[0]!;

    // Another browser (no cookie) completing the OAuth flow is rejected, and the state is burned.
    const other = await fetch(`${base}/withings/callback?code=c1&state=${state}`);
    expect(other.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getTokens('owner@example.com')).toBeUndefined();

    // A fresh, confirmed state with the matching cookie succeeds.
    const state2 = store.createState('owner@example.com');
    const confirmed2 = await fetch(`${base}/withings/connect`, {
      method: 'POST',
      body: new URLSearchParams({ state: state2, confirm_identity: 'yes' }),
      redirect: 'manual',
    });
    const cookie2 = confirmed2.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie2).not.toBe(nonce);
    const ok = await fetch(`${base}/withings/callback?code=c2&state=${state2}`, { headers: { cookie: cookie2 } });
    expect(ok.status).toBe(200);
    expect(store.getTokens('owner@example.com')?.withingsUserId).toBe('9');

    // Single use.
    const replay = await fetch(`${base}/withings/callback?code=c2&state=${state2}`, { headers: { cookie: cookie2 } });
    expect(replay.status).toBe(400);
  });

  it('callback rejects an unconfirmed state even with some cookie', async () => {
    const { store, base } = await start();
    const state = store.createState('owner@example.com');
    const r = await fetch(`${base}/withings/callback?code=c&state=${state}`, { headers: { cookie: `${ENROLL_COOKIE}=guess` } });
    expect(r.status).toBe(400);
    expect(store.getTokens('owner@example.com')).toBeUndefined();
  });

  it('/mcp rejects requests without the bearer', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-user': 'victim@example.com' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });
});
