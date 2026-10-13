# Changelog

## Unreleased

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
