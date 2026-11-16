import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import type { WithingsClient } from '../withings/client.js';
import type { TokenStore } from '../withings/store.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  AuthFailureLimiter,
  corsHeaders,
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
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
  /** Defaults to console.error. */
  log?: (line: string) => void;
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

export function createHttpHandler({ config, store, client, log: logOption }: HttpAppDeps): RequestListener {
  const log = logOption ?? ((line: string) => console.error(line));
  const failureLimit = config.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  const limiter = failureLimit > 0
    ? new AuthFailureLimiter(failureLimit, config.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS)
    : undefined;

  return async (req, res) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const describeRequest = () => `${req.method ?? '-'} ${(req.url ?? '').split('?')[0]!.slice(0, 200)} from ${remote}`;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Enrollment interstitial: reached directly by the user's browser through a
      // reverse proxy (not by the MCP client), so it does not require the /mcp
      // bearer. It shows which identity the link is bound to and requires an
      // explicit confirmation before redirecting to Withings.
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
          res.writeHead(200, corsHeaders(req, config));
          res.end();
          return;
        }
        await handleCallback(req, res, url, store, client);
        return;
      }

      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (url.pathname !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        // Only failing requests are counted and throttled; a valid token is never blocked.
        if (limiter) {
          const retryAfter = limiter.retryAfterSeconds(remote);
          if (retryAfter > 0) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts' }, req, {
              'Retry-After': String(retryAfter),
            }, config);
            return;
          }
          if (limiter.recordFailure(remote)) {
            log(`[http] ${remote} reached ${failureLimit} failed authentication attempts; further failures get 429`);
          }
        }
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);
      const forwardedUser = config.trustForwardedUser ? firstHeader(req.headers['x-mcp-user']) : undefined;

      const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${describeRequest()}: ${error.message}`);
        if (!res.headersSent && !res.destroyed) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${describeRequest()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req, {}, config);
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
