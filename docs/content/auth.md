# Authentication

Each VisionSet server serves one workspace. A valid API token grants access to the whole workspace.
For HTTP clients, create a named token with the CLI and send it in the bearer header:

```http
Authorization: Bearer <workspace-token>
```

The browser app can also use a session cookie issued by the server. The CLI and the local stdio
MCP server call the SDK directly and use the caller's filesystem access.

## The token

VisionSet generates a random 256-bit secret. The workspace stores its SHA-256 digest alongside
the token's name, creation time, and optional revocation time. The secret is returned only when
you create it. If it is lost, create a replacement.

Token names are unique within a workspace, ignoring case. Revocation keeps the existing row and
its name, so use a new name when issuing a replacement.

## Issuing and revoking

Use the `token` commands from the workspace directory or pass `--workspace` to the command:

```bash
visionset token create --name ci
visionset token list
visionset token revoke ci
```

Revocation applies on the next request. If you revoke a token again, the CLI reports the original
revocation time. Use `--yes` to confirm revocation in a script.

### At a terminal

By default, `token create` prints only the secret on stdout. It writes the creation message and
storage reminder to stderr. With `--json`, the response includes a `secret` field. Token listings
show the name and timestamps in either output mode.

A refused operation exits with status 1 and writes a message to stderr. With `--json`, stdout
also includes the structured error. Command-line usage errors exit with status 2. See
[CLI output and errors](cli.md).

## The browser session

Open the app on localhost after starting `visionset server`. The browser calls `GET /session`.
When the request is eligible, the endpoint returns `{"issued": true}` and sets the
`visionset_session` cookie. The session secret is stored in `<workspace>/.ui-session` with
mode `0600` and persists across server restarts. Deleting that file invalidates outstanding
cookies. An eligible browser can request a new session.

On protected requests the server checks the bearer token first. If no bearer token validates,
it also checks any session cookie supplied with the request.

### Who is issued one

Set `VISIONSET_UI_SESSION` to control session issuance:

| Value | Eligible request |
| --- | --- |
| `auto` (default) | The peer is a loopback address and the request addresses the server as `localhost`, a loopback IP, or a `*.localhost` hostname. |
| `always` | Any peer or hostname. Use this only behind a front door that restricts access to clients you trust with the entire workspace. |
| `never` | No requests receive a session. Sign in with an API token. |

An unrecognized setting falls back to `auto`. This setting controls issuance. To invalidate
previously issued cookies, delete `<workspace>/.ui-session`. With `auto`, a client connecting over the LAN
needs a token even if the server listens on all interfaces. The development Compose deployment
uses `always` behind its proxy and trusts clients that can reach its front door.

### Why a cookie, and why it is not weaker than what it replaced

The browser sends the session cookie automatically on requests to the workspace origin.
`HttpOnly` keeps it out of page scripts, and `SameSite=Strict` keeps it off cross-site requests.
The server sets `Secure` for HTTPS requests.
The packaged app, Vite development proxy, and Compose proxy each serve the app and its API
through one origin. `GET /session` is an app bootstrap route outside the OpenAPI contract.

### When the form still appears

The app shows its token form when the server cannot issue a session. This includes LAN
connections in `auto` mode and all connections in `never` mode. **Use a token** switches from
automatic sign-in to the form for the current page. Reloading can establish a session again.
When signed in with an API token, the control reads **Sign out**.

## What a refusal looks like

When neither credential validates, protected endpoints return the same response for missing,
malformed, unknown, and revoked credentials:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer

{"code": "UNAUTHORIZED", "message": "Invalid or missing bearer token", "detail": null}
```

A workspace failure is reported separately. For example, contention can return
`503 WORKSPACE_BUSY` and an unreadable store can return `500 WORKSPACE_CORRUPT`. See
[REST error handling](api.md#the-error-body).

## Which workspace the server serves

`visionset server` applies the CLI's workspace selection rules, including `--workspace`, before
starting the server. When the application is run directly by import string, the server uses
`VISIONSET_WORKSPACE` if set or looks for the nearest workspace at or above its working directory.
Read the [workspace resolution rules](workspaces.md#which-workspace-when-nobody-said).

A server pointed at an invalid workspace can still answer `GET /health`. A protected request
returns `500 NOT_A_WORKSPACE` with an `incident_id` if its configured directory is not a
workspace. The path is available in the server log.

## For contributors

Use `protected_router()` for routes that require a workspace credential. It registers the
authentication dependency and documents the 401 response together.
`tests/server/test_openapi_contract.py` checks the generated specification for both public and
protected operations.

`/health`, `/session`, `/docs`, `/redoc`, and `/openapi.json` are public. The app shell can
load before authentication. Its requests for workspace data use protected API routes. API-token
administration is a local CLI operation.
