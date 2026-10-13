import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

export interface HttpConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  httpToken?: string;
}

export function getHttpConfig(): HttpConfig {
  return {
    host: process.env.MCP_HTTP_HOST ?? process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    maxBodyBytes: Number(process.env.MCP_MAX_BODY_BYTES ?? 10_485_760),
    httpToken: process.env.MCP_HTTP_TOKEN?.trim() || undefined,
  };
}

export function assertAuthorized(req: IncomingMessage, config = getHttpConfig()): void {
  if (!config.httpToken) {
    // Fail closed: when X-MCP-User is trusted, /mcp must never be reachable without the
    // gateway bearer (assertSecureStartup normally prevents this configuration).
    if (trustsForwardedUser()) {
      throw new HttpRequestError(401, 'Unauthorized');
    }
    return;
  }

  if (!bearerMatches(req.headers.authorization, config.httpToken)) {
    throw new HttpRequestError(401, 'Unauthorized');
  }
}

/** Constant-time comparison of an Authorization header against `Bearer <token>`. */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const supplied = createHash('sha256').update(authorization ?? '').digest();
  return timingSafeEqual(expected, supplied);
}

function trustsForwardedUser(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WITHINGS_TRUST_FORWARDED_USER === 'true';
}

/**
 * Refuse to start when the forwarded identity header is trusted but /mcp is not
 * protected by the gateway bearer — otherwise anyone reaching the port could act as
 * any user by sending X-MCP-User.
 */
export function assertSecureStartup(env: NodeJS.ProcessEnv = process.env): void {
  if (trustsForwardedUser(env) && !(env.MCP_HTTP_TOKEN ?? '').trim()) {
    throw new Error(
      'Refusing to start: WITHINGS_TRUST_FORWARDED_USER=true requires MCP_HTTP_TOKEN (the shared bearer the ' +
        'gateway sends on /mcp). Without it, anyone who can reach this port could act as any user. ' +
        'Set MCP_HTTP_TOKEN to a long random secret.',
    );
  }
}

/** Escape text for safe interpolation into HTML (element content and quoted attributes). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assertAllowedOrigin(req: IncomingMessage): void {
  if (!isOriginAllowed(req.headers.origin)) {
    throw new HttpRequestError(403, 'Origin not allowed');
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes = getHttpConfig().maxBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  req?: IncomingMessage,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
  };

  if (process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin || process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    return true;
  }

  const configuredOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (configuredOrigins.length) {
    return configuredOrigins.includes(origin);
  }

  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}
