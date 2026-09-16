# Third-party notices — `@visionset/browser-inference`

This package is licensed under Apache-2.0, like the rest of
[VisionSet](https://github.com/Robomous/VisionSet). It redistributes one dependency — ONNX
Runtime Web — both as compiled JavaScript and as verbatim WebAssembly artifacts, and this file
is the notice that redistribution owes. It is a record of what is shipped and under what terms,
not legal advice.

The notice travels inside the published package deliberately: a consumer installing the tarball
has the built artifacts and no repository, so a link to a file in the source tree would resolve
to nothing for exactly the reader who needs this.

## ONNX Runtime Web — MIT

| | |
| --- | --- |
| Package | [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) |
| Version | `1.29.0`, pinned exactly in `package.json` |
| Licence | MIT |
| Source | <https://github.com/microsoft/onnxruntime> |
| Modified | **No.** Consumed as an unmodified published package. |

ONNX Runtime Web executes model graphs in the browser; it is how this package turns a model
into an answer without a server.

**It is redistributed twice over, not merely depended on.**

Its JavaScript is compiled into `dist/browser/worker.js`. Inference runs in a module worker,
and a worker gets no import map from the document that started it, so a bare `onnxruntime-web`
specifier surviving into that file would be unresolvable in any host that does not run a bundler
over `node_modules`.

Its WebAssembly runtime — `ort-wasm-simd-threaded.asyncify.mjs` and
`ort-wasm-simd-threaded.asyncify.wasm` — is copied verbatim into `dist/browser/ort/` at build
time. Those files cannot be bundled; they are fetched at run time, and a package that did not
carry them would install successfully and then fail on first use in any host that had not been
told to serve them separately. (The `.asyncify` pair, not `.jsep`: ORT 1.29's native WebGPU
execution provider needs asyncify to suspend a call across GPU work, since JSEP is on its way
out. This was measured by running the built worker, not assumed from the changelog.)

**The published `onnxruntime-web` tarball carries no `LICENSE` file.** Beside its `dist/` it
ships only `README.md`, `package.json` and `types.d.ts`; the MIT grant is declared in
`package.json`'s `license` field. MIT requires its copyright notice and permission notice to
accompany redistribution, so this package carries the upstream text itself, verbatim and
unparaphrased, at [`LICENSES/onnxruntime-MIT.txt`](LICENSES/onnxruntime-MIT.txt) — taken from
the `v1.29.0` tag of the upstream repository linked above. It is listed in `package.json`'s
`files` so that it cannot be dropped from a published tarball without the omission being
deliberate.

MIT is permissive: nothing here becomes MIT-licensed by proximity, and this package's own
Apache-2.0 grant is unaffected. The corresponding source, unmodified and at the exact version
this package depends on, is at the repository linked above.

## Everything else

`onnxruntime-web` brings its own dependencies — `onnxruntime-common` (MIT), `long` (Apache-2.0),
`platform` (MIT), `protobufjs` (BSD-3-Clause), `flatbuffers` (Apache-2.0) and `guid-typescript`
(ISC). All are permissive. The authoritative, version-exact list is the lockfile in the VisionSet
repository, which names every package and version actually resolved — a hand-maintained list here
would only drift from it.

No model weights are shipped by this package, so no model licence appears here. When a model
does ship, its licence is that artifact's own question and belongs beside it.
