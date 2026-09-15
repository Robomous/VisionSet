# Third-party notices

VisionSet is licensed under Apache-2.0 ([`LICENSE`](LICENSE)). It depends on third-party
software that keeps its own licence, and some of that software is *redistributed* rather
than merely depended on: `pip install visionset` ships a compiled browser bundle in
`src/visionset/_static/`, and everything that bundle contains travels with it.

This file records the notices that redistribution owes. It is a record of what is shipped
and under what terms, not legal advice.

## Mediabunny — MPL-2.0

| | |
| --- | --- |
| Package | [`mediabunny`](https://www.npmjs.com/package/mediabunny) |
| Licence | Mozilla Public License 2.0 |
| Source | <https://github.com/Vanilagy/mediabunny> |
| Used by | `@visionset/media`, and through it the browser bundle in the Python wheel |
| Modified | **No.** Consumed as an unmodified published package. |

Mediabunny parses video containers and drives the browser's own WebCodecs decoders; it is
how VisionSet turns a local video into image assets without a server-side decoder. It is
the one redistributed dependency under a file-level copyleft licence, which is why it has
a section to itself.

**It is compiled into the artifacts, not merely depended on.** `@visionset/media` runs the
decode pipeline in a module worker, and a worker gets no import map from the document that
started it, so a bare `mediabunny` specifier surviving into `dist/mediabunny/worker.js`
would be unresolvable in any host that does not run a bundler over `node_modules`. The
worker therefore bundles it. Mediabunny's compiled code is consequently inside the
published `@visionset/media` package **and** inside the browser bundle that ships in the
Python wheel, with its own `/*! … */` banners preserved in both.

MPL-2.0 attaches to Mediabunny's own files, and bundling is distribution in executable
form rather than modification: VisionSet neither alters those files nor copies them into
its source tree. No VisionSet file becomes MPL-2.0, and VisionSet's own Apache-2.0 grant
is unaffected. The corresponding source, unmodified and at the exact published version the
lockfile names, is at the repository linked above.

## Everything else

The remaining dependencies are permissively licensed (MIT, BSD, Apache-2.0, ISC and
similar). The authoritative, version-exact list is the lockfiles — `uv.lock` for the Python
distribution and `pnpm-lock.yaml` for the frontend workspace — each of which names every
package and version actually resolved, which a hand-maintained list here would only drift
from.
