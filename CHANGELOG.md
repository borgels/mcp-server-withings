# Changelog

## 0.2.0

### Changes

- HTTP: the server refuses to start without `MCP_HTTP_TOKEN` when bound to a
  non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true` (in addition to
  `WITHINGS_TRUST_FORWARDED_USER=true`). `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is
  an explicit escape hatch for the first two cases only.
- HTTP: `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- HTTP: failed `/mcp` authentications are limited per client address (429 with
  `Retry-After`); valid tokens are never throttled. New `MCP_AUTH_FAILURE_LIMIT`
  (default 20, `0` disables) and `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- HTTP: `Host` header check on `/mcp` for loopback binds (`MCP_ALLOWED_HOSTS`).
- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON returns 400
  (JSON-RPC parse error) instead of 500; oversized bodies are refused from
  `Content-Length` before reading; one log line per rejected request.
- HTTP: new `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES`, `WITHINGS_TIMEOUT_MS` and the boolean `MCP_*`
  flags are validated at startup; invalid values stop the server instead of
  becoming `NaN`.
- Withings client: redirects are never followed, so `client_secret` (token
  requests) and access tokens cannot be re-sent to another host.
- The MCP server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, patched
  transitive dependencies). CI: pinned actions, image build on pull requests,
  images published only after tests pass, with SBOM and provenance.

### Upgrade notes

- Deployments binding a non-loopback address must set `MCP_HTTP_TOKEN` (at
  least 32 characters, e.g. `openssl rand -hex 32`). A shorter token now stops
  the server.
- Invalid values for the variables above now stop the server at startup.
- Unchanged: `/withings/connect` and `/withings/callback` remain reachable
  without the bearer.

### Also in this release

- Security: refuse to start when `WITHINGS_TRUST_FORWARDED_USER=true` and `MCP_HTTP_TOKEN` is
  unset (and fail closed on `/mcp` in that case); the bearer is compared in constant time.
- Security: enrollment — `withings_connect` now returns a link to `/withings/connect`, which shows the gateway identity the link is bound to and requires an explicit confirmation before redirecting to Withings. The callback is accepted only from the browser that confirmed (HttpOnly, SameSite=Lax cookie), and the state stays single-use with a 10-minute TTL. Route `/withings/connect` to this container alongside `/withings/callback`.

## 0.1.0

Initial release.

- Per-user Withings Health API MCP server: each user links their OWN account via
  OAuth2 (withings_connect → browser consent → /withings/callback) and sees only
  their own data. Tokens are AES-256-GCM encrypted at rest, keyed by the
  gateway-verified identity (X-MCP-User); fail-closed without it.
- Tools: measures (weight/composition/BP/SpO2…), activity, sleep, workouts,
  heart/ECG, devices, goals; add_measure (write, gated). Enrollment: connect,
  status, disconnect.
- Refresh-token rotation persisted atomically; per-user serialized refresh;
  429 (status 601) surfaced with backoff hint.
