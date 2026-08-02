export interface WithingsErrorPayload {
  error?: string;
  message?: string;
  code?: string | number;
}

const SECRET_PATTERNS = [
  /authorization:\s*bearer\s+[^,\s}]+/gi,
  /(access_token|refresh_token|client_secret|WITHINGS_CLIENT_SECRET)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class WithingsHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: WithingsErrorPayload | unknown;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: WithingsErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatWithingsHttpError(input));
    this.name = 'WithingsHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatWithingsHttpError(input: {
  status: number;
  url: string;
  payload?: WithingsErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isWithingsErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Withings API request failed with HTTP ${input.status}`,
    payload?.code === undefined ? undefined : `code=${payload.code}`,
    payload?.error,
    payload?.message,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isWithingsErrorPayload(value: unknown): value is WithingsErrorPayload {
  return typeof value === 'object' && value !== null;
}
