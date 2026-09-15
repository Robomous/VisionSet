# A connection is not a browser

An [`InferenceConnection`](../backend/inference.md) describes a model **the VisionSet server
machine can run**. `ConnectionType.LOCAL` means local to that machine, and it never means local
to a browser. A model that runs in someone's browser is not represented as a connection row, is
not given a `setup_state`, and is not written to the workspace at all.

## What the type owns

`local` is not a label. It is the entry point to a body of server-side state:

- where the weights live on disk, and the cache that keeps them;
- the download that puts them there, and the integrity check that says they arrived intact;
- `setup_state`, which is how every surface asks whether the connection can be used yet;
- device and precision;
- provider resolution, and the pool that keeps a loaded provider alive between requests;
- the server-side image-embedding cache that makes a second click on the same asset cheap.

All of it is **workspace-scoped and persisted**. One row, one answer, shared by everyone who
opens that workspace.

## Why a browser cannot be described that way

Whether a model can run in a browser is a fact about one browser profile on one machine. It
depends on what that browser has stored, what execution backends it exposes, and how much
memory it can spare. Two people in the same workspace disagree. One person on a laptop and the
same person on a desktop disagree. The same browser, in a private window, disagrees with
itself.

There is therefore no honest value for `setup_state` to take. Whatever a row said, it would be
right for at most one reader, and every other reader would be told that a model is ready when
it is not - or that it is missing when it is sitting in their own cache. The failure is not
cosmetic: `setup_state` is what the editor consults before offering the tool, so a wrong
answer either hides a working capability or offers a control that cannot be honored.

## What this forbids

- adding a `browser` member to `ConnectionType`;
- a nullable `connection_id` on a suggestion, so that "no connection" can mean "the browser";
- a synthetic connection row standing in for "this device";
- any write to the server recording what a browser has or can do;
- reading `setup_state` as an answer about anything other than the server.

## What holds instead

The capability is declared by the host at runtime, not by a row - see
[browser inference is host-injected](browser-inference-is-host-injected.md). The two kinds of
answer meet at one shape, which is [asking is not sending](asking-is-not-sending.md).
