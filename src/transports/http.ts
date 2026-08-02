import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { WithingsClient } from '../withings/client.js';
import { TokenStore } from '../withings/store.js';
import { trustForwardedUser } from '../withings/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

const config = getHttpConfig();

// Shared, long-lived across requests: the encrypted token store and the OAuth
// client. Per-request MCP servers bind to the calling user but reuse these.
const store = new TokenStore();
const client = new WithingsClient();

const httpServer = createNodeServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Public OAuth callback — Withings (and the user's browser) reach this
    // directly (Caddy routes /withings/* to the container, NOT via the gateway),
    // so it must NOT require the gateway bearer. Security comes from the
    // single-use, user-bound `state`.
    if (url.pathname === '/withings/callback') {
      await handleCallback(url, res);
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
});

async function handleCallback(url: URL, res: import('node:http').ServerResponse): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const page = (title: string, msg: string, ok: boolean) =>
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>${ok ? '✅' : '⚠️'} ${title}</h1><p>${msg}</p></body>`;
  try {
    if (!code || !state) {
      throw new Error('Missing code/state.');
    }
    const user = store.consumeState(state);
    if (!user) {
      throw new Error('This link is invalid or expired. Run withings_connect again in Claude.');
    }
    const tokens = await client.exchangeCode(code);
    store.setTokens(user, tokens);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Withings connected', 'Your Withings account is now linked. You can close this tab and return to Claude.', true));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Withings connection failed', error instanceof Error ? error.message : 'Unknown error.', false));
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`Withings MCP HTTP server listening on http://${config.host}:${config.port} (/mcp + /withings/callback)`);
});
