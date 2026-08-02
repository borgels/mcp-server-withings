import { WithingsHttpError } from '../errors.js';
import type { TokenStore, UserTokens } from './store.js';

export interface WithingsClientOptions {
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;
  accountBaseUrl?: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const WITHINGS_SCOPES = 'user.info,user.metrics,user.activity';
/** Refresh when the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface TokenResponseBody {
  userid?: string | number;
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}

/**
 * Withings API client. All data + token calls are POST form-urlencoded with a
 * mandatory `action` param against wbsapi.withings.net; the response body's
 * `status` field carries errors (0 = ok), not the HTTP code. Refresh tokens
 * ROTATE on every use and must be persisted atomically.
 */
export class WithingsClient {
  readonly clientId: string;
  private readonly clientSecret: string;
  readonly apiBaseUrl: string;
  readonly accountBaseUrl: string;
  readonly redirectUri: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly refreshing = new Map<string, Promise<UserTokens>>();

  constructor(options: WithingsClientOptions = {}) {
    this.clientId = options.clientId ?? process.env.WITHINGS_CLIENT_ID ?? '';
    this.clientSecret = options.clientSecret ?? process.env.WITHINGS_CLIENT_SECRET ?? '';
    this.apiBaseUrl = trimSlash(options.apiBaseUrl ?? process.env.WITHINGS_API_BASE_URL ?? 'https://wbsapi.withings.net');
    this.accountBaseUrl = trimSlash(
      options.accountBaseUrl ?? process.env.WITHINGS_ACCOUNT_BASE_URL ?? 'https://account.withings.com',
    );
    this.redirectUri = options.redirectUri ?? process.env.WITHINGS_REDIRECT_URI ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.WITHINGS_TIMEOUT_MS ?? 30_000);
  }

  private requireConfigured(): void {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('Withings app is not configured (WITHINGS_CLIENT_ID / _SECRET / _REDIRECT_URI).');
    }
  }

  /** Browser authorization URL for a user to grant consent. */
  authorizeUrl(state: string): string {
    this.requireConfigured();
    const url = new URL(`${this.accountBaseUrl}/oauth2_user/authorize2`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('scope', WITHINGS_SCOPES);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async oauth(params: Record<string, string>): Promise<UserTokens> {
    this.requireConfigured();
    const body = new URLSearchParams({
      action: 'requesttoken',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...params,
    });
    const url = `${this.apiBaseUrl}/v2/oauth2`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { status?: number; body?: TokenResponseBody } | null;
    if (!json || json.status !== 0 || !json.body?.access_token || !json.body.refresh_token) {
      throw new WithingsHttpError({
        status: res.status,
        url,
        payload: json,
        fallbackMessage: `Withings token request failed (status ${json?.status ?? '?'}).`,
      });
    }
    const b = json.body;
    return {
      withingsUserId: String(b.userid ?? ''),
      accessToken: b.access_token!,
      refreshToken: b.refresh_token!,
      accessExpiresAt: Date.now() + (b.expires_in ?? 10_800) * 1000,
      scope: b.scope ?? WITHINGS_SCOPES,
      connectedAt: Date.now(),
    };
  }

  exchangeCode(code: string): Promise<UserTokens> {
    return this.oauth({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
  }

  /** Return a valid access token for the user, refreshing (with rotation) if needed. */
  async validAccessToken(user: string, store: TokenStore): Promise<string> {
    const current = store.getTokens(user);
    if (!current) {
      throw new Error('NOT_ENROLLED');
    }
    if (Date.now() < current.accessExpiresAt - REFRESH_SKEW_MS) {
      return current.accessToken;
    }
    // Serialize refreshes per user to avoid rotating the token from under a concurrent call.
    const inflight = this.refreshing.get(user);
    if (inflight) {
      return (await inflight).accessToken;
    }
    const p = (async () => {
      const refreshed = await this.oauth({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      // Preserve the Withings user id (refresh response may omit it).
      refreshed.withingsUserId = refreshed.withingsUserId || current.withingsUserId;
      refreshed.connectedAt = current.connectedAt;
      store.setTokens(user, refreshed); // persist the rotated refresh token atomically
      return refreshed;
    })().finally(() => this.refreshing.delete(user));
    this.refreshing.set(user, p);
    return (await p).accessToken;
  }

  /** Call a data endpoint (POST form + action). Throws on status != 0. */
  async call<T = unknown>(
    user: string,
    store: TokenStore,
    path: string,
    action: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const token = await this.validAccessToken(user, store);
    const body = new URLSearchParams({ action });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') {
        body.set(k, String(v));
      }
    }
    const url = `${this.apiBaseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { status?: number; body?: T } | null;
    if (!json || json.status !== 0) {
      throw new WithingsHttpError({
        status: res.status,
        url: `${url} (${action})`,
        payload: json,
        retryAfter: json?.status === 601 ? '60' : undefined,
        fallbackMessage: `Withings ${action} failed (status ${json?.status ?? '?'}).`,
      });
    }
    return json.body as T;
  }
}

function trimSlash(v: string): string {
  return v.replace(/\/+$/, '');
}
