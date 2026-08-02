import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WithingsClient, type WithingsClientOptions } from './withings/client.js';
import { TokenStore } from './withings/store.js';
import { registerWithingsTools } from './tools/withings.js';

export interface CreateServerOptions {
  client?: WithingsClient;
  clientOptions?: WithingsClientOptions;
  store?: TokenStore;
  /** Gateway-verified end-user identity; every tool is bound to this user's own data. */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'withings', version: '0.1.0' });
  const client = options.client ?? new WithingsClient(options.clientOptions);
  const store = options.store ?? new TokenStore();
  registerWithingsTools(server, client, store, { onBehalfOf: options.onBehalfOf });
  return server;
}
