import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-user encrypted token store + one-time enrollment-state store.
 *
 * Every user's Withings tokens are encrypted at rest with AES-256-GCM using a
 * key derived from WITHINGS_ENCRYPTION_KEY. Tokens are keyed by the
 * gateway-verified user identity, so a user can only ever reach their own row.
 * Persisted to a JSON file on a Docker volume (survives restarts).
 */

export interface UserTokens {
  withingsUserId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  scope: string;
  connectedAt: number;
}

interface EnrollState {
  user: string;
  createdAt: number;
}

interface Encrypted {
  iv: string;
  tag: string;
  data: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export class TokenStore {
  private readonly path: string;
  private readonly key: Buffer;
  private tokens: Record<string, Encrypted> = {};
  private states: Record<string, EnrollState> = {};

  constructor(options: { path?: string; encryptionKey?: string } = {}) {
    this.path = options.path ?? process.env.WITHINGS_STORE_PATH ?? '/data/store.json';
    const secret = options.encryptionKey ?? process.env.WITHINGS_ENCRYPTION_KEY;
    if (!secret || secret.length < 16) {
      throw new Error('Missing/weak WITHINGS_ENCRYPTION_KEY (min 16 chars) — required to encrypt tokens at rest.');
    }
    this.key = createHash('sha256').update(secret).digest();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        tokens?: Record<string, Encrypted>;
        states?: Record<string, EnrollState>;
      };
      this.tokens = raw.tokens ?? {};
      this.states = raw.states ?? {};
    } catch {
      this.tokens = {};
      this.states = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.store.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ tokens: this.tokens, states: this.states }), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace
  }

  private encrypt(value: UserTokens): Encrypted {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt(enc: Encrypted): UserTokens {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8')) as UserTokens;
  }

  /** userKey normalizes the verified identity (lowercased email/oid). */
  static userKey(identity: string): string {
    return identity.trim().toLowerCase();
  }

  getTokens(user: string): UserTokens | undefined {
    const enc = this.tokens[TokenStore.userKey(user)];
    return enc ? this.decrypt(enc) : undefined;
  }

  setTokens(user: string, tokens: UserTokens): void {
    this.tokens[TokenStore.userKey(user)] = this.encrypt(tokens);
    this.persist();
  }

  deleteTokens(user: string): boolean {
    const key = TokenStore.userKey(user);
    if (!this.tokens[key]) {
      return false;
    }
    delete this.tokens[key];
    this.persist();
    return true;
  }

  // --- one-time enrollment state (binds the OAuth callback to a user) ---

  createState(user: string): string {
    this.gcStates();
    const state = randomBytes(24).toString('base64url');
    this.states[state] = { user: TokenStore.userKey(user), createdAt: Date.now() };
    this.persist();
    return state;
  }

  consumeState(state: string): string | undefined {
    this.gcStates();
    const entry = this.states[state];
    if (!entry) {
      return undefined;
    }
    delete this.states[state];
    this.persist();
    return Date.now() - entry.createdAt <= STATE_TTL_MS ? entry.user : undefined;
  }

  private gcStates(): void {
    const now = Date.now();
    let changed = false;
    for (const [s, e] of Object.entries(this.states)) {
      if (now - e.createdAt > STATE_TTL_MS) {
        delete this.states[s];
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}
