# mcp-server-withings

MCP server for the [Withings Health API](https://developer.withings.com/) with **per-user OAuth2** — each user links their own Withings account and can only ever see their own health data.

This is an independent, unofficial project. It is not developed, endorsed or supported by Withings.

## How isolation works

Behind an authenticating gateway that forwards the signed-in user as `X-MCP-User`, every tool is bound to that user. The server keeps an **AES-256-GCM encrypted, per-user token store**; a user's identity resolves only to their own row. Without a verified identity the server fails closed (no anonymous/shared access). Each user enrolls once via `withings_connect`, which returns a single-use Withings authorization URL bound to them; after they approve in the browser, `/withings/callback` stores their (encrypted) tokens.

## Tools

**Auth/enrollment:** `withings_connect`, `withings_status`, `withings_disconnect`.
**Read:** `withings_get_measures`, `withings_get_activity`, `withings_get_sleep`, `withings_get_workouts`, `withings_get_heart`, `withings_get_devices`, `withings_get_goals`, `withings_search_capabilities`.
**Write (opt-in `WITHINGS_ENABLE_WRITES=true`):** `withings_add_measure`.

## Configuration

See `.env.example`. Register a Withings app at account.withings.com; the redirect URI must match `WITHINGS_REDIRECT_URI` exactly and be publicly reachable (route `/withings/callback` to this container). Set `WITHINGS_ENCRYPTION_KEY` (never commit) and `WITHINGS_TRUST_FORWARDED_USER=true` behind the gateway.

## Security configuration

- `MCP_HTTP_TOKEN` — shared bearer the gateway must send on `/mcp` (`Authorization: Bearer <token>`), compared in constant time, at least 32 printable ASCII characters (e.g. `openssl rand -hex 32`). The server **refuses to start** without it when `WITHINGS_TRUST_FORWARDED_USER=true` (otherwise anyone who can reach the port could claim any `X-MCP-User`), when bound to a non-loopback address, or with `MCP_ALLOW_ANY_ORIGIN=true`. Keep `/mcp` reachable only from the gateway.
- `/withings/connect`, `/withings/callback` and `/healthz` need no bearer.
- Enrollment: `withings_connect` returns a link to `/withings/connect`, which shows the gateway identity the link is bound to and requires an explicit confirmation before redirecting to Withings. The callback is accepted only from the browser that confirmed (HttpOnly, SameSite=Lax cookie), and the state stays single-use with a 10-minute TTL. Route `/withings/connect` to this container alongside `/withings/callback`.

### HTTP transport variables

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | - | Bearer token required on `/mcp`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve `/mcp` without a token on a non-loopback bind or with `MCP_ALLOW_ANY_ORIGIN` (logs a warning). Never allowed together with `WITHINGS_TRUST_FORWARDED_USER=true`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Largest accepted `/mcp` request body. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed on `/mcp`. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin`; requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | see below | Comma-separated host names accepted in the `Host` header on `/mcp`. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed `/mcp` authentications per client address and window before further failures get 429; `0` disables. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |
| `WITHINGS_TIMEOUT_MS` | `30000` | Upstream request timeout (1-600000 ms). |

On a loopback bind, `/mcp` only accepts `localhost`, `127.0.0.1`, `[::1]` or the bind address in the `Host` header (DNS-rebinding protection); set `MCP_ALLOWED_HOSTS` to change this. Invalid numbers or booleans in these variables stop the server at startup instead of being ignored.

## Security model

- Each user links their own Withings account via OAuth; tools only use the tokens stored for the identity in `X-MCP-User`. That header is only trusted with `WITHINGS_TRUST_FORWARDED_USER=true`, and only behind `MCP_HTTP_TOKEN`.
- User authentication and authorization belong in an identity-aware gateway in front of this server: it signs the user in, sets `X-MCP-User` and holds the bearer token. This server does not authenticate end users itself.
- Tool access is not data access: whoever can call `/mcp` with the bearer and a given `X-MCP-User` value acts as that user against Withings.
- Upstream requests never follow redirects, so the client secret and access tokens are only sent to the configured Withings API origin.
- The HTTP server does not terminate TLS. Put it behind a TLS-terminating proxy or keep it on a private network.

## Run

```bash
npm install
npm run dev:http     # /mcp + /withings/connect + /withings/callback on :3000
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-withings`.

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.3.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
