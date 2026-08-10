# inference

[`src/visionset/inference/`](../../../src/visionset/inference/) is the composition
root for models: a configuration row in, a running `ModelProvider` out.

## Why it is its own package

Running a model means torch and transformers, and the kernel may import neither —
the port describes a protocol, and the kernel has to stay implementable on a
machine that could not run anything. So the code that turns a row into a running
model cannot live in the kernel. It must not live in a delivery package either:
the CLI, the API and a background worker all need it, and shared logic moves
*down*, never sideways. One package above the kernel and beside `formats`, `wire`
and `jobs` is the only place left.

## Resolution is two steps

```mermaid
flowchart LR
    Conn["InferenceConnection<br/>a row somebody wrote"]
    Kind{"connection kind"}
    Cfg["the model's own config<br/>model_type"]
    Fam{"family"}
    Text["text-prompt adapter"]
    Point["point-prompt adapter"]
    Refuse["refused — no adapter"]

    Conn --> Kind
    Kind -->|local| Cfg
    Cfg --> Fam
    Fam -->|detector| Text
    Fam -->|segmenter| Point
    Fam -->|unknown| Refuse
```

**There is no entry-point group**, and that is the decision rather than an
omission. `Importer` and `Exporter` name `visionset.formats` because a format is a
plugin a third party ships. A provider is not that shape: adapters are
instantiated from **user-created connections** and never from a bundled default,
which makes `InferenceConnection` the registry — a row naming a kind, a model and
where it runs. A provider discovered by entry point would have nothing to be
instantiated *from*, and a workspace could acquire the ability to predict through
an unrelated `pip install`, which is precisely what "VisionSet never downloads a
model on its own" exists to prevent.

The connection's kind says *where*; the model's own config says *which family*.
A family this build does not serve is refused rather than guessed at — a fallback
answers in the wrong adapter's vocabulary, which is a confident sentence about a
model the user does not have.

## One fact, two readings, one module

`families.py` holds the family sets **and** the map from a family to what a
connection may be asked for, because they are the same fact read twice: which
adapter can run this model, and which prompts a caller may send it. The map is
*derived* from the sets rather than listed beside them, so an adapter and its
declaration are one edit — a family added to `SEGMENTER_FAMILIES` and forgotten in
a hand-written map would run fine and declare nothing, and every client that
filters on the declaration would stop offering it.

The vocabulary itself is the kernel's (`ModelCapability`) and the mapping is not:
what a tool can ask for is a domain word, while which `model_type` values this
build serves is a fact about an optional runtime that the kernel has no view of.

## The family is recorded, not only resolved

Resolution used to happen on every provider build and be thrown away. A connection
now stores what its config declared, written when the download finishes — the
first moment the answer exists without reaching a network, and the reason nothing
is read at connection *creation*.

**The backfill for older rows is on the read path, and that is a layering fact.**
A migration would be the natural home and cannot be one: migrations run inside the
kernel, and the kernel may not import this package or address the model cache the
answer lives in. So `with_families` fills a row in on the first read of it, from
files already on the disk, once — a row that has an answer is never asked again,
including when the answer is "the config declared nothing". A build without the
optional runtime records nothing rather than recording that it found nothing,
because a build that cannot look has not looked.

## Importing this package imports nothing heavy

Every reference to torch, transformers, accelerate and huggingface_hub is inside a
function. A base install starts a server, runs a worker and imports this module
with the optional runtime absent, and
[`tests/architecture/test_optional_runtime.py`](../../../tests/architecture/test_optional_runtime.py)
proves it in a fresh interpreter.

**That proof needs an environment where the libraries are actually installed.**
On a machine without them, "importing the product left torch out of `sys.modules`"
is true whatever the code does, so the assertion passes and says nothing. CI's
`inference-smoke` job is where it means something: it installs the extra from the
lockfile and runs this file among the rest of the inference surface. The two
halves of that matrix, and the environment variable that keeps the with-runtime
half honest, are described in
[CONTRIBUTING](../../../CONTRIBUTING.md#the-two-halves-of-the-inference-matrix).

The optional **extra** is `local-inference` — an extra rather than a dependency
group, because a group is for developing this repository and this is something a
user installs. `_extra.py` names what it brings and turns a missing one into a
sentence carrying the install command.

## Where it sits

`visionset.inference` may not import `visionset.server`, `visionset.cli`,
`visionset.mcp` or `visionset.jobs`. The last is not tidiness: the download
handler imports *this*, so the reverse would close a cycle — and would put the
optional runtime back on the path a worker takes at spawn.

The port itself is held to a narrower rule by
[`tests/architecture/test_model_provider_port.py`](../../../tests/architecture/test_model_provider_port.py):
`kernel/ports/model_provider.py` may import the kernel's own domain and the
standard library, and nothing else. A signature naming a `Path` says there is a
filesystem in common; one naming a tensor says there is an array library in
common. Neither survives a network, and the port has to be implementable across
one.

## Related

[`docs/inference.md`](../../inference.md) is the surface: the connections, why
nothing is downloaded on your behalf, the two kinds, why the revision is pinned,
and where weights land.
