# Authentication

A VisionSet workspace is operated with an **API token**. There is one kind of credential, it is
scoped to one workspace, and holding a valid one means holding the whole workspace: granular
permissions are deliberately not here.

```
visionset token create --name ci     # prints the secret once — issue #26
```

```
Authorization: Bearer vst_hK3n...
```

Every REST endpoint except `/health` requires it. The CLI and the MCP server do not: they call
the SDK in the same process, on a machine whose filesystem the caller already has.

## The token

| Field | |
| --- | --- |
| `name` | What an operator calls it. Unique per workspace, case-insensitively. |
| `created_at` | When it was issued. |
| `revoked_at` | When it was burned, or absent while it still works. |

The secret itself is **not** stored — only its SHA-256 digest. `TokenService.create` returns the
plaintext exactly once, in an `IssuedToken`, and nothing can recover it afterwards. The remedy
for a lost token is a new token.

> ### Why a digest and not a password KDF
>
> A KDF (argon2, bcrypt) exists to make *low-entropy, human-chosen* input expensive to guess. A
> VisionSet secret is 256 bits from `secrets.token_urlsafe`: there is no dictionary to run and no
> guessing budget that terminates. Two more reasons make it the right call rather than merely a
> defensible one. Verification runs on **every request** and compares the presentation against
> every token the workspace holds, so a 100 ms KDF would cost N × 100 ms *per request* — the
> opposite cost model to a login form, where the check runs once and rate limiting bounds it. And
> `hashlib` is stdlib, where a KDF is a dependency taken on for no gain.
>
> The accepted consequence, stated rather than hidden: the digest is unsalted and deterministic,
> so two identical secrets hash identically. That requires drawing the same 256-bit value twice —
> and it is exactly the property that lets verification be a digest comparison rather than N key
> derivations.

Names are unique per workspace so that `visionset token revoke ci` resolves to one credential.
Uniqueness is enforced twice, the way project names are: `uq_token_workspace_name` (`COLLATE
NOCASE`) is the guarantee, and `TokenService`'s pre-check is the error message.

## Issuing and revoking

`TokenService` is the one door. `AuthProvider` — the port all three surfaces authenticate through
— stays a single method, `verify(token) -> bool`; minting and revoking are use cases, and widening
the port would oblige every future provider to implement issuance it has no business doing.

**Revocation is immediate and one-way.** `revoke` takes `confirm=True`, because it breaks every
client holding that secret at the next request and there is no `unrevoke`: reinstating a secret
somebody decided to burn is worse than issuing a fresh one, since the reason for burning it does
not expire. Revoking twice is a no-op that keeps the first timestamp, so a retried command is
safe. The row stays — it is the record that the credential existed and when it died — which is
also why revocation does not free the name.

Nothing caches a verdict. "Revoked, therefore refused" has to mean *now*, so the provider reads
the workspace on every call. That read is cheap: WAL readers never block a writer, and a
read-only unit of work takes no lock at all.

## What a refusal looks like

A missing header, a non-bearer scheme, an empty credential, an unknown token and a revoked token
are **one answer**, byte for byte:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer

{"code": "UNAUTHORIZED", "message": "Invalid or missing bearer token", "detail": null}
```

That uniformity is the point. A 401 that distinguished "no such token" from "revoked" would let
anyone enumerate a workspace's credentials one request at a time.

A failure to *decide* is not a refusal. If the store is unreachable or damaged, `verify` raises
rather than answering `False`, and the client sees a 503 (`WORKSPACE_BUSY`) or a 500
(`WORKSPACE_CORRUPT`). Reporting an outage as a bad credential sends an operator hunting for the
wrong thing.

## Which workspace the server serves

One, named by **`VISIONSET_WORKSPACE`**, defaulting to the process's working directory. It is
opened by the first request that needs it and kept for the life of the process — never at import
time, because `scripts/export_openapi.py` imports the application in a checkout that has no
workspace.

A server pointed at something that is not a workspace answers **500 `NOT_A_WORKSPACE`**, opaque
body plus an `incident_id`, with the path in the log only. That is a deployment fault, not a
client error. It arrives *instead of* a 401 even when no token was sent, because the workspace is
resolved before the credential is looked at — the ordering is what keeps authentication
overridable in tests.

> The full resolution rule — a `--workspace` flag, the environment variable, cwd detection, and a
> documented precedence shared with the CLI — belongs to issue #26.
> `server/dependencies.py::resolve_workspace_root` is the provisional half, reading the variable
> #26 will keep.

## For contributors

Build every non-public router with **`protected_router()`**:

```python
from visionset.server.dependencies import WorkspaceDep, protected_router
from visionset.server.errors import ERROR_RESPONSES

router = protected_router(prefix="/projects", tags=["projects"])


@router.get("/{project_id}", responses={404: ERROR_RESPONSES[404]})
def get_project(project_id: UUID, workspace: WorkspaceDep) -> ProjectOut: ...
```

It carries the dependency *and* the documented 401 together, because a route that declares one
without the other is a lie in `openapi.json` either way. Do not repeat `Depends(require_token)`
per route — "everything except `/health`" should be a property of how routers are constructed,
not something each reviewer has to notice — and do not add 401 to `UNIVERSAL_ERROR_RESPONSES`,
because `/health` is public and cannot 401.
`tests/server/test_openapi_contract.py` walks the spec and fails on either mistake.

`/docs`, `/redoc` and `/openapi.json` stay public. They are `include_in_schema=False`, and the
spec is already a committed artifact in a public repository: a contract you must authenticate to
read is a contract nobody generates a client from.

**There is no MCP tool for token administration, and that is deliberate.** Every other tool
operates on *datasets*; one that minted a credential would operate on *access to the workspace* —
a privilege-escalation primitive pointed at the agent's own sandbox, producing a durable secret
that outlives the session. The secret is shown exactly once, and an agent's "once" is a
transcript: `confirm: true` guards accidental mutation, not exfiltration. Whoever launched
`visionset mcp` already had workspace access, so a second credential adds capability and subtracts
accountability. `list_tokens` is the only defensible candidate and is still operator surface
rather than dataset surface.
