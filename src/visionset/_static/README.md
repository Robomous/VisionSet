# `_static/` — compiled UI bundle

At build time, the compiled `@visionset/app` bundle (`frontend/app/dist/`) is copied here by
the root script `pnpm bundle:static`, so the UI travels **inside the single Python wheel** as
package data and `visionset ui` can serve it with zero extra downloads.

Everything in this directory except this README and `.gitkeep` is git-ignored: the bundle is
a build artifact, never a committed source.
