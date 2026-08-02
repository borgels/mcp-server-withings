# Changelog

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
