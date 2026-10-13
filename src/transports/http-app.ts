import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import type { WithingsClient } from '../withings/client.js';
import type { TokenStore } from '../withings/store.js';
import { trustForwardedUser } from '../withings/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  escapeHtml,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpAppDeps {
  config: HttpConfig;
  store: TokenStore;
  client: WithingsClient;
}

/** Cookie binding the browser that confirmed the enrollment to the OAuth callback. */
export const ENROLL_COOKIE = 'withings_enroll';
const ENROLL_COOKIE_MAX_AGE_S = 10 * 60;
const MAX_FORM_BYTES = 8 * 1024;

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

export function createHttpHandler({ config, store, client }: HttpAppDeps): RequestListener {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Enrollment interstitial — reached directly by the user's browser (Caddy routes
      // /withings/* to the container, NOT via the gateway). It shows which gateway
      // identity the link is bound to and requires an explicit confirmation before
      // redirecting to Withings.
      if (url.pathname === '/withings/connect') {
        await handleConnect(req, res, url, store, client);
        return;
      }

      // Public OAuth callback — Withings (and the user's browser) reach this directly,
      // so it must NOT require the gateway bearer. Security comes from the single-use,
      // user-bound `state` that the same browser explicitly confirmed.
      if (url.pathname === '/withings/callback') {
        // Withings validates the registered URL with a HEAD request and requires a
        // 2xx reply (developer.withings.com callback-url-requirements). Answer HEAD
        // (and bare visits) with 200 so registration/validation passes.
        if (req.method === 'HEAD') {
          res.writeHead(200, corsHeaders(req));
          res.end();
          return;
        }
        await handleCallback(req, res, url, store, client);
        return;
      }

      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not found' }, req);
        return;
      }

      assertAllowedOrigin(req);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
        return;
      }

      assertAuthorized(req, config);
      const body = await readJsonBody(req, config.maxBodyBytes);

      const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

      const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        if (error instanceof HttpRequestError) {
          sendJson(res, error.status, { error: error.message }, req);
          return;
        }
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req);
      }
    }
  };
}

function page(title: string, bodyHtml: string, ok: boolean): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>${ok ? '✅' : '⚠️'} ${escapeHtml(title)}</h1>${bodyHtml}</body>`;
}

function textPage(title: string, msg: string, ok: boolean): string {
  return page(title, `<p>${escapeHtml(msg)}</p>`, ok);
}

function confirmPage(state: string, user: string, error?: string): string {
  const err = error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : '';
  return page(
    'Connect Withings',
    `${err}<p style="padding:.75rem;border:2px solid #b60;background:#fff4e5;font-size:1.1rem">You are linking a Withings account to <b>${escapeHtml(user)}</b>.</p>` +
      '<p>Only continue if this is <b>your</b> identity and you started this link yourself from your own Claude session. If not, close this page.</p>' +
      `<form method="post" action="/withings/connect"><input type="hidden" name="state" value="${escapeHtml(state)}">` +
      `<label><input type="checkbox" name="confirm_identity" value="yes" required> Yes, link my Withings account to ${escapeHtml(user)}</label>` +
      '<br><button style="margin-top:1rem;padding:.6rem 1rem">Continue to Withings</button></form>',
    true,
  );
}

const EXPIRED_MSG = 'This link is invalid or expired. Run withings_connect again in Claude.';

async function handleConnect(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: TokenStore,
  client: WithingsClient,
): Promise<void> {
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const user = state ? store.peekState(state) : undefined;
    if (!user) {
      res.writeHead(400, PAGE_HEADERS);
      res.end(textPage('Link expired', EXPIRED_MSG, false));
      return;
    }
    res.writeHead(200, PAGE_HEADERS);
    res.end(confirmPage(state, user));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...PAGE_HEADERS, Allow: 'GET, POST' });
    res.end(textPage('Method not allowed', 'Use the link returned by withings_connect.', false));
    return;
  }

  const form = await readFormBody(req);
  const state = form.get('state') ?? '';
  const user = state ? store.peekState(state) : undefined;
  if (!user) {
    res.writeHead(400, PAGE_HEADERS);
    res.end(textPage('Link expired', EXPIRED_MSG, false));
    return;
  }
  if (form.get('confirm_identity') !== 'yes') {
    res.writeHead(400, PAGE_HEADERS);
    res.end(confirmPage(state, user, 'Please tick the box to confirm.'));
    return;
  }
  const nonce = store.confirmState(state);
  if (!nonce) {
    res.writeHead(400, PAGE_HEADERS);
    res.end(textPage('Link expired', EXPIRED_MSG, false));
    return;
  }
  const secure = client.redirectUri.startsWith('https:') ? '; Secure' : '';
  res.writeHead(303, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': `${ENROLL_COOKIE}=${nonce}; Path=/withings; Max-Age=${ENROLL_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`,
    Location: client.authorizeUrl(state),
  });
  res.end();
}

async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: TokenStore,
  client: WithingsClient,
): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Bare visit / validation probe (no OAuth params) → 200 so reachability checks pass.
  if (!code && !state) {
    res.writeHead(200, PAGE_HEADERS);
    res.end(textPage('Withings connector', 'This endpoint completes Withings sign-in. Start from Claude with the withings_connect tool.', true));
    return;
  }
  const clearCookie = `${ENROLL_COOKIE}=; Path=/withings; Max-Age=0; HttpOnly; SameSite=Lax`;
  try {
    if (!code || !state) {
      throw new Error('Missing code/state.');
    }
    const user = store.consumeConfirmedState(state, readCookie(req, ENROLL_COOKIE));
    if (!user) {
      throw new Error(
        'This link is invalid, expired, or was not confirmed in this browser. Run withings_connect again in Claude and open the link in your own browser.',
      );
    }
    const tokens = await client.exchangeCode(code);
    store.setTokens(user, tokens);
    res.writeHead(200, { ...PAGE_HEADERS, 'Set-Cookie': clearCookie });
    res.end(textPage('Withings connected', 'Your Withings account is now linked. You can close this tab and return to Claude.', true));
  } catch (error) {
    res.writeHead(400, { ...PAGE_HEADERS, 'Set-Cookie': clearCookie });
    res.end(textPage('Withings connection failed', error instanceof Error ? error.message : 'Unknown error.', false));
  }
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_FORM_BYTES) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim() || undefined;
    }
  }
  return undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
