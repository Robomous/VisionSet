# `_static/` — compiled UI bundle

At build time, the compiled `@visionset/app` bundle (`frontend/app/dist/`) is copied here by
the root script `pnpm bundle:static`, so the UI travels **inside the single Python wheel** as
package data and `visionset ui` can serve it with zero extra downloads.

Everything in this directory except this README and `.gitkeep` is git-ignored: the bundle is
a build artifact, never a committed source. This README and `.gitkeep` are also what make the
directory exist in every checkout, which is what lets the server mount it unconditionally.

## Served at `/app/`, not at `/`

`create_app()` mounts this directory at `/app` (`UI_PREFIX` in `server/main.py`) and redirects
`/` to it. The API owns the root — `/projects/{project_id}` is a shipped route — so an app
served from `/` could never claim `/projects/abc` as one of its own client routes.

That is why `frontend/app/vite.config.ts` sets `base: "/app/"` **for builds only**. If the files
here reference `/assets/...` rather than `/app/assets/...`, they were built before that landed:
rerun `pnpm -r build && pnpm bundle:static`.

Until somebody does, `GET /` answers a 404 that names the command. A missing bundle is an
ordinary state of a source checkout, not a fault.
