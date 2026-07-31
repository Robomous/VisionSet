# The browser client

How `@visionset/ui-core` talks to the API, and the three decisions every screen
inherits: where the API is, which credential is in use, and what happens when that
credential stops working.

The **visual** contract is [`DESIGN.md`](../DESIGN.md) at the repository root. This
document is the data half.

## Routes

`@visionset/app` is shell only, and `src/routes.tsx` is the whole of it.

| route | what | behind the token gate |
| --- | --- | --- |
| `/` | Home | yes |
| `/projects`, `/projects/:id`, `/projects/:id/ingest`, `/projects/:id/batches/:id`, `/projects/:id/dataset` | the product | yes |
| `/jobs/:jobId` | the annotation page | yes |
| `/demo` | the annotator showcase (`?scene=bench` for #49's benchmark) | **no** |
| `/styleguide` | the rendered design system | **no** |

The last two need no server and no credential — the showcase's picture is a `data:`
URI and the styleguide is pure CSS — so putting them behind the gate would ask for a
token to look at a page that cannot use one. They are also what lets the browser
suite run with no backend.

The router's basename is `import.meta.env.BASE_URL`, which is what vite substitutes
for its `base` option — so the router and the bundle cannot disagree about the `/ui`
prefix the wheel serves under. A **reload** on a client route is a real request for a
path no file backs; [`api.md`](api.md#where-the-ui-lives) describes the server-side
fallback that answers it.

The rail is the whole shell: logo, collapse toggle, Home, Projects, sign out. Anything
richer growing on it is what the thin-app audit exists to catch — a capability in
`app/` is one the future enterprise UI cannot reuse.

## Screens

A screen is a component in `@visionset/ui-core` and a route in `@visionset/app`. It
takes **navigation as a callback**, never a router: a screen that called
`useNavigate` would only work inside a `react-router` tree, which is a dependency
the future enterprise UI has no reason to share.

Query keys are hierarchical — `["projects"]` → `["projects", id]` →
`["projects", id, "schema"]` — because TanStack Query matches a **prefix**. So
invalidating `["projects", id]` after a rename refreshes the project, its schema and
its version list, and the mutation never has to enumerate what it affected.

### The ingest flow, and the order the domain forces

The issue asks for an fps parameter "with original-fps display from the probe".
Those two cannot happen in that order, and the screen says so rather than
designing around it.

`extraction_fps` belongs to the **source**, not to the run — "same source, same
assets" only means something if the parameters are part of what the source *is* —
and the probe result exists only once the clip is registered. So the rate is chosen
first, the clip is registered, and then its native fps, duration, codec and
resolution are shown. Registering the same clip at another rate produces a
**second source**, deliberately: idempotency is on `(kind, path, extraction_fps)`.

Three more things it inherits:

- **Refusals split by when they can be known** (#28). A bad batch target is 404 or
  409 *before a job row exists*, so it renders on the launch form. Everything after
  the launch is on the job: `error` is the one fatal cause, `failures` is the
  per-item report.
- **`total` is `null` for a clip.** `VideoMetadata` carries no frame count by
  design, so an extraction has no denominator until it is over — a directory states
  its total before the first file. The progress readout shows a count instead of a
  percentage rather than inventing one.
- **The per-file report is grouped by kind**, which is the whole reason
  `IngestFailureKind` exists: `unsupported` is operator noise, `corrupt` is data
  loss, and reading fifty rows to notice the second is the mistake a table can
  prevent. Names are rendered as basenames with the full string in `title`, because
  for a *directory* ingest `IngestFailure.name` is the full server path — a known
  kernel inconsistency, deliberately left alone.

Nothing is filtered in the browser and there is no `react-dropzone`. Every filter
the library would apply — MIME type, size, per-file rejection — is a rule the server
already owns and refuses better, with the kernel's own reason; duplicating it here
would be a second spelling of the accepted-format list.

### The schema editor, and the two 409s

The editor is where `docs/api.md`'s "branch on the code, never on the status" earns
its keep, because both refusals are **409** and only one may be retried:

| code | what it means | what the editor offers |
| --- | --- | --- |
| `DESTRUCTIVE_SCHEMA_CHANGE` | the new version narrows the contract | **Save anyway**, which retries with `?allow_destructive=true` |
| `SCHEMA_CHANGE_WOULD_ORPHAN` | annotations already exist under an affected class | **Close**, and nothing else |

A client branching on the status would offer the override for both and loop forever
on the second — the failure `SchemaChangeWouldOrphan`'s kernel docstring warns
about, and the reason it is deliberately *not* a subclass of
`DestructiveSchemaChange`. The missing button is the feature.

There is no preview: `SchemaService.preview` and `compare` exist in the kernel and
are deliberately unrouted, so the only way to learn a change is destructive is to
attempt it and read the refusal. That is why the refusal surface is the editor's
real subject.

Three other decisions the editor inherits rather than invents:

- **A version is immutable**, so the editor drafts and *publishes N+1*. Past
  versions are read-only because they are read-only — there are no controls, not
  disabled ones.
- **`?confirm=true` and `?allow_destructive=true` are different words** and are
  never merged. `confirm=` guards destroying data (deleting a project);
  `allow_destructive=` guards narrowing a contract. Each has its own dialog.
- **A 404 from `GET /schema` is an answer**, not a failure: a project starts
  schema-less on purpose, so that code becomes an empty draft rather than an error
  surface.

The geometry picker offers `bbox`, `polygon` and `classification_tag` — the three an
`Annotation` can carry. `GeometryType` declares eight; the kernel refuses the rest
at write time with `UnsupportedGeometry`, and offering a choice the API will refuse
is worse than not offering it.

A class **description** is not editable, because `LabelClassBody` does not carry
one. Left out rather than stored where it would not survive a round trip.

## No screen calls `fetch`

`frontend/ui-core/src/client.ts` is the only hand-written module that knows how a
request is made, and `createApiClient` is the only thing that builds one. Everything
about *what* can be requested — paths, parameters, bodies, response shapes — comes
from `src/generated/api.ts`, generated from the committed `openapi.json` and gated
against it on every pull request. A screen that mistypes a route fails to compile.

A screen reaches the client through a hook:

```tsx
const client = useApiClient();
const projects = useQuery({
  queryKey: ["projects"],
  queryFn: async () => unwrap(await client.GET("/projects", {})),
});
```

`unwrap` is the single adapter between the two models in play. `openapi-fetch` never
throws — it answers `{data, error, response}` and leaves the branch to the caller —
while TanStack Query's entire model is resolve-or-reject, and "rejected" is what
drives `isError`, retries and the error surface. Because every call goes through
`unwrap`, no screen in this repository writes `if (error)` by hand.

## Reading a refusal

The API emits [one error body](api.md) at every status: `{code, message, detail?}`.
`unwrap` turns it into an `ApiError` whose **first** field is the code, because
`docs/api.md`'s rule is that clients branch on the code and never on the status —
`DESTRUCTIVE_SCHEMA_CHANGE` and `SCHEMA_CHANGE_WOULD_ORPHAN` are both 409 and only
the first is retryable with a flag.

Two codes are the client's own, for answers the contract cannot describe:

| code | when |
| --- | --- |
| `NETWORK_ERROR` | the request never reached a server — the most likely failure on a tool whose server you start by hand |
| `MALFORMED_RESPONSE` | something answered, but not with the contract's shape: a proxy, a gateway, an HTML error page |

`ApiError.incidentId` reads `detail.incident_id`, which is where a 5xx puts the one
thing a person can quote when the message itself is deliberately withheld.

## The token

There are no accounts. A token is minted out of band —
`visionset token create --name ui`, which prints the secret exactly once — and the
browser presents it as `Authorization: Bearer`.

`TokenGate` shows the app when a token is held and the entry form when it is not.
The form **verifies before it adopts**: it spends one `GET /projects` with a
throwaway client and only calls `signIn` on a 200. Storing whatever was pasted and
letting the first screen fail would put the error on a project list, which then
reports a problem about projects when the real problem is the credential.

Refusals are told apart by what to do next, not by status: a 401 says the token was
refused (mistyped, revoked, or minted for a different workspace — the API answers
one identical 401 for all four cases and a client must not pretend otherwise), and a
`NETWORK_ERROR` says the server is not answering and names `visionset ui`.

### Where it is kept, and why

**`sessionStorage`.** The credential survives a reload — which matters, because the
annotation page is the one screen somebody sits on for an hour and losing the token
on an accidental refresh, with unsaved geometry on the canvas, is the worst moment
this product has — and it is per tab, so two workspaces in two tabs do not overwrite
each other.

`localStorage` was rejected: it writes a long-lived bearer credential to disk with no
expiry, and VisionSet tokens are valid until somebody runs `visionset token revoke`.
In-memory-only was rejected for the reload. A cookie would need a login endpoint the
API does not have.

Against XSS, `sessionStorage` is not meaningfully safer than a variable — an injected
script can read a React context just as easily, and does not need the token at all
when it is already running on an authenticated page. The defence is a
Content-Security-Policy, not a storage choice.

Every access is guarded: `sessionStorage` **throws** rather than returning null when
a browser refuses it, during the first render, before any error boundary exists. The
fallback is an in-memory store, so the session degrades to "until you reload" instead
of to a blank page.

## The 401 is handled once

`ApiProvider` subscribes to the query cache and the mutation cache, and any 401 from
anywhere clears the token. It is a **subscription**, not an `onError` on the
`QueryClient` the provider builds, and the difference is load-bearing: the client is
a prop, so a caller may supply their own, and a handler configured at construction is
then simply absent for the whole application.

Handling it per screen fails in a specific way. A token revoked while an annotator
has a job open produces a 401 from whichever request fires next — usually a
background refetch nobody is looking at. A per-screen check would leave that screen
showing an error and every other screen showing stale data that will never refresh.

Retries follow: a 401 is not transient, and retrying one is three more requests with
a credential already known to be bad.

## Loading, empty, error

```tsx
<Async query={projects} empty={{ title: "No projects yet", action: <Button>New project</Button> }}>
  {(page) => <ProjectTable rows={page.items} />}
</Async>
```

The three branches a hurried screen skips are the ones `Async` writes. Emptiness is
**opt-in and asked for**: the default predicate is the API's own list envelope
(`total === 0`) and nothing else, because a component that guessed would be wrong for
`dataset_stats`, whose zeroes are a real answer about a real dataset.

## Polling

`usePollingQuery` for the operations that finish on their own schedule — ingest, and
anything else launched with a 202. The predicate is named for the **settled** state
rather than for "keep going", because the terminal states are enumerated in the domain
and the running ones are not; a predicate written the other way round silently keeps
polling a state somebody adds later.

## Where the API is

`ApiProvider` takes `baseUrl` and the app decides it — a library that reads
`import.meta.env` is a library that can only be built one way.

- **Production**: `""`. `visionset ui` serves the API at the root and the bundle at
  `/ui`, so a relative request already lands on it.
- **Development**: `"/api"`, proxied by vite to `http://127.0.0.1:8000` (override with
  `VISIONSET_API`).

The proxy rather than CORS on the server, and the prefix rather than proxying the
API's own paths. CORS would put a middleware in front of every response *in
production too*, and the catch-all `Exception` handler lives in
`ServerErrorMiddleware`, outside the user middleware stack — so a CORS layer would
not run on a 500 anyway. The prefix exists because the API owns the root: `/projects`
is both a real endpoint and a client route the SPA will want.
