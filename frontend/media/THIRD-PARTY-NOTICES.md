# Third-party notices — `@visionset/media`

This package is licensed under Apache-2.0, like the rest of
[VisionSet](https://github.com/Robomous/VisionSet). It ships one redistributed dependency
under a file-level copyleft licence, which this file records. It is a record of what is
shipped and under what terms, not legal advice.

The notice travels inside the published package deliberately: a consumer installing the
tarball has the built artifacts and no repository, so a link to a file in the source tree
would resolve to nothing for exactly the reader who needs this.

## Mediabunny — MPL-2.0

| | |
| --- | --- |
| Package | [`mediabunny`](https://www.npmjs.com/package/mediabunny) |
| Licence | Mozilla Public License 2.0 |
| Source | <https://github.com/Vanilagy/mediabunny> |
| Modified | **No.** Consumed as an unmodified published package. |

Mediabunny parses video containers and drives the browser's own WebCodecs decoders; it is
how this package turns a local video into image frames with no server-side decoder.

**It is compiled into `dist/mediabunny/worker.js`, not merely depended on.** The decode
pipeline runs in a module worker, and a worker gets no import map from the document that
started it, so a bare `mediabunny` specifier surviving into that file would be unresolvable
in any host that does not run a bundler over `node_modules`. The worker therefore bundles
it, with Mediabunny's own `/*! … */` banners preserved.

MPL-2.0 attaches to Mediabunny's own files, and bundling is distribution in executable form
rather than modification: nothing here alters those files or copies them into this package's
source. No VisionSet file becomes MPL-2.0, and this package's own Apache-2.0 grant is
unaffected. The corresponding source, unmodified and at the exact version this package
depends on, is at the repository linked above.

## Everything else

The remaining dependencies are permissively licensed (MIT, BSD, Apache-2.0, ISC and
similar). The authoritative, version-exact list is the lockfile in the VisionSet repository,
which names every package and version actually resolved — a hand-maintained list here would
only drift from it.
