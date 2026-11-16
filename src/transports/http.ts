import { WithingsClient } from '../withings/client.js';
import { TokenStore } from '../withings/store.js';
import { configWarnings, getHttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

function fail(error: unknown): never {
  console.error(`Withings MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let deps;
  try {
    // Refuses insecure combinations, including X-MCP-User trust without MCP_HTTP_TOKEN.
    const config = getHttpConfig();
    // Shared, long-lived across requests: the encrypted token store and the OAuth
    // client. Per-request MCP servers bind to the calling user but reuse these.
    deps = { config, store: new TokenStore(), client: new WithingsClient() };
  } catch (error) {
    fail(error);
  }

  for (const warning of configWarnings(deps.config)) {
    console.error(warning);
  }

  const running = await startHttpServer(deps);
  console.error(
    `Withings MCP HTTP server listening on http://${deps.config.host}:${running.port} ` +
      '(/mcp + /withings/connect + /withings/callback)',
  );

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
