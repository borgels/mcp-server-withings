# mcp-server-withings

MCP server for the [Withings Health API](https://developer.withings.com/) with **per-user OAuth2** — each user links their own Withings account and can only ever see their own health data.

## How isolation works

Behind an authenticating gateway that forwards the signed-in user as `X-MCP-User`, every tool is bound to that user. The server keeps an **AES-256-GCM encrypted, per-user token store**; a user's identity resolves only to their own row. Without a verified identity the server fails closed (no anonymous/shared access). Each user enrolls once via `withings_connect`, which returns a single-use Withings authorization URL bound to them; after they approve in the browser, `/withings/callback` stores their (encrypted) tokens.

## Tools

**Auth/enrollment:** `withings_connect`, `withings_status`, `withings_disconnect`.
**Read:** `withings_get_measures`, `withings_get_activity`, `withings_get_sleep`, `withings_get_workouts`, `withings_get_heart`, `withings_get_devices`, `withings_get_goals`, `withings_search_capabilities`.
**Write (opt-in `WITHINGS_ENABLE_WRITES=true`):** `withings_add_measure`.

## Configuration

See `.env.example`. Register a Withings app at account.withings.com; the redirect URI must match `WITHINGS_REDIRECT_URI` exactly and be publicly reachable (route `/withings/callback` to this container). Set `WITHINGS_ENCRYPTION_KEY` (never commit) and `WITHINGS_TRUST_FORWARDED_USER=true` behind the gateway.

## Security configuration

- `MCP_HTTP_TOKEN` — shared bearer the gateway must send on `/mcp` (`Authorization: Bearer <token>`), compared in constant time. It is **required** when `WITHINGS_TRUST_FORWARDED_USER=true`: the server refuses to start without it, because otherwise anyone who can reach the port could claim any `X-MCP-User`. Keep `/mcp` reachable only from the gateway.
- Enrollment: `withings_connect` now returns a link to `/withings/connect`, which shows the gateway identity the link is bound to and requires an explicit confirmation before redirecting to Withings. The callback is accepted only from the browser that confirmed (HttpOnly, SameSite=Lax cookie), and the state stays single-use with a 10-minute TTL. Route `/withings/connect` to this container alongside `/withings/callback`.

## Run

```bash
npm install
npm run dev:http     # /mcp + /withings/connect + /withings/callback on :3000
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-withings`.
