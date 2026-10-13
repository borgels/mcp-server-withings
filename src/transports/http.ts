import { createServer as createNodeServer } from 'node:http';
import { WithingsClient } from '../withings/client.js';
import { TokenStore } from '../withings/store.js';
import { createHttpHandler } from './http-app.js';
import { assertSecureStartup, getHttpConfig } from './http-helpers.js';

// Refuse to start if X-MCP-User would be trusted without the gateway bearer on /mcp.
try {
  assertSecureStartup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const config = getHttpConfig();

// Shared, long-lived across requests: the encrypted token store and the OAuth
// client. Per-request MCP servers bind to the calling user but reuse these.
const store = new TokenStore();
const client = new WithingsClient();

const httpServer = createNodeServer(createHttpHandler({ config, store, client }));

httpServer.listen(config.port, config.host, () => {
  console.error(
    `Withings MCP HTTP server listening on http://${config.host}:${config.port} (/mcp + /withings/connect + /withings/callback)`,
  );
});
